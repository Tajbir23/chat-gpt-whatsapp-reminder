const express = require('express')
const path = require('path')
const getNumber = require('./getNumber')
const { initWhatsapp, getWhatsappState } = require('./login-whatsapp')

require('dotenv').config()
const fetchPolyfill = (typeof fetch !== 'undefined') ? fetch : ((...args) => import('node-fetch').then(({default: f}) => f(...args)))

const app = express()

// View engine
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Randomized delay helpers
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function randomIntInclusive(min, max) {
	const lo = Math.ceil(min)
	const hi = Math.floor(max)
	return Math.floor(Math.random() * (hi - lo + 1)) + lo
}
const MIN_DELAY_SEC = Number(process.env.MIN_DELAY_SEC || 2)
const MAX_DELAY_SEC = Number(process.env.MAX_DELAY_SEC || 6)
function nextDelayMs() {
	const a = isNaN(MIN_DELAY_SEC) ? 2 : MIN_DELAY_SEC
	const b = isNaN(MAX_DELAY_SEC) ? 6 : MAX_DELAY_SEC
	const lo = Math.max(0, Math.min(a, b))
	const hi = Math.max(a, b)
	return randomIntInclusive(lo * 1000, hi * 1000)
}

// Anti-detection tuning
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 0) // 0 = no cap
const LONG_BREAK_EVERY = Number(process.env.LONG_BREAK_EVERY || 15)
const LONG_BREAK_MIN_SEC = Number(process.env.LONG_BREAK_MIN_SEC || 25)
const LONG_BREAK_MAX_SEC = Number(process.env.LONG_BREAK_MAX_SEC || 60)

function shuffle(array) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[array[i], array[j]] = [array[j], array[i]]
	}
	return array
}

function expandSpintax(text) {
	if (!text || typeof text !== 'string') return text
	return text.replace(/\{([^{}]+)\}/g, (_, group) => {
		const options = group.split('|')
		return options[Math.floor(Math.random() * options.length)]
	})
}

// Home page
app.get('/', async (req, res) => {
	try { await initWhatsapp() } catch {}
	const state = getWhatsappState()
	res.render('home', { state })
})

// Polling state; also try to init if needed so QR appears
app.get('/api/state', async (req, res) => {
	const s = getWhatsappState()
	if ((!s.client || s.status === 'error') && !s.isCreating) {
		try { await initWhatsapp() } catch {}
	}
	res.json(getWhatsappState())
})

// Endpoint used by client to get numbers between dates
app.post('/get-number', getNumber)

// Send messages to all numbers
app.post('/send', async (req, res) => {
	const { id, startDate, endDate, message } = req.body
	const state = getWhatsappState()
	const client = state.client
	if (!client || !state.loggedIn) {
		return res.status(400).json({ message: 'WhatsApp not logged in' })
	}

	try {
		// Fetch numbers
		const numbersResponse = await fetchPolyfill(`http://localhost:3000/get-number?id=${encodeURIComponent(id)}` ,{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ startDate, endDate })
		})
		const data = await numbersResponse.json()
		const rawNumbers = Array.isArray(data?.numbers) ? data.numbers : data

		if (!Array.isArray(rawNumbers) || rawNumbers.length === 0) {
			return res.status(200).json({ sent: 0, total: 0 })
		}

		// Sanitize, dedupe, shuffle, and cap per run
		let numbers = Array.from(new Set(
			rawNumbers.map((n) => String(n).replace(/\D+/g, '')).filter((d) => d.length >= 8)
		))
		numbers = shuffle(numbers)
		if (MAX_PER_RUN > 0) numbers = numbers.slice(0, MAX_PER_RUN)

		// Reset progress for this run
		progress = { sent: 0, total: numbers.length, last: null, done: false, failed: 0, skipped: 0, lastError: null, lastSkipped: null }

		// Start background send, return immediately
		queueMicrotask(async () => {
			let sent = 0
			for (let i = 0; i < numbers.length; i++) {
				const digits = numbers[i]
				const jid = `${digits}@c.us`

				// Pre-check if number can receive message (best-effort)
				try {
					if (typeof client.checkNumberStatus === 'function') {
						const st = await client.checkNumberStatus(jid)
						const can = !!(st && (st.canReceiveMessage || st.numberExists))
						if (!can) {
							progress.skipped += 1
							progress.lastSkipped = digits
							// wait a tiny random time to reduce pattern
							await sleep(randomIntInclusive(200, 700))
							continue
						}
					}
				} catch (e) {
					// ignore check errors and try sending
				}

				try {
					const text = expandSpintax(message)
					await client.sendText(jid, text)
					sent += 1
					progress.sent = sent
					progress.total = numbers.length
					progress.last = digits
				} catch (err) {
					console.error('Failed to send to', digits, err)
					progress.failed += 1
					progress.lastError = { number: digits, message: String(err && err.message || err) }
					// Backoff more on errors
					await sleep(randomIntInclusive(10000, 20000))
				}
				// Periodic long break
				if (LONG_BREAK_EVERY > 0 && i > 0 && (i % LONG_BREAK_EVERY) === 0) {
					await sleep(randomIntInclusive(
						Math.max(0, LONG_BREAK_MIN_SEC) * 1000,
						Math.max(LONG_BREAK_MIN_SEC, LONG_BREAK_MAX_SEC) * 1000
					))
				}
				// Randomized delay between messages, except after last
				if (i < numbers.length - 1) {
					await sleep(nextDelayMs())
				}
			}
			progress.done = true
		})

		res.json({ started: true })
	} catch (error) {
		console.error(error)
		res.status(500).json({ message: 'Internal server error' })
	}
})

// In-memory progress (simple, single-run)
let progress = { sent: 0, total: 0, last: null, done: false, failed: 0, skipped: 0, lastError: null, lastSkipped: null }

// SSE for progress
app.get('/progress', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache')
	res.setHeader('Connection', 'keep-alive')
	res.flushHeaders?.()

	const send = () => {
		res.write(`data: ${JSON.stringify(progress)}\n\n`)
	}

	const interval = setInterval(send, 1000)
	send()

	req.on('close', () => {
		clearInterval(interval)
	})
})

app.listen(3000, () => {
	console.log('Server is running on http://localhost:3000')
})