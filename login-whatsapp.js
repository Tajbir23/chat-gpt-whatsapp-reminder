require('dotenv').config()
const venom = require('venom-bot')
const EventEmitter = require('events')

const whatsappEvents = new EventEmitter()

const whatsappState = {
	client: null,
	loggedIn: false,
	qrDataUrl: null,
	status: 'initializing',
	isCreating: false
}

function getWhatsappState() {
	return { ...whatsappState }
}

function onWhatsappEvent(eventName, listener) {
	whatsappEvents.on(eventName, listener)
}

function emitAndSave(eventName, payload) {
	if (eventName === 'qr' && payload) {
		whatsappState.qrDataUrl = payload
		whatsappState.loggedIn = false
		whatsappState.status = 'qr'
	}
	if (eventName === 'status') {
		whatsappState.status = payload
	}
	if (eventName === 'loggedIn') {
		whatsappState.loggedIn = true
		whatsappState.status = 'ready'
		whatsappState.qrDataUrl = null
	}
	if (eventName === 'loggedOut') {
		whatsappState.loggedIn = false
		whatsappState.status = 'disconnected'
	}
	whatsappEvents.emit(eventName, payload)
}

async function initWhatsapp() {
	if (whatsappState.client) return whatsappState.client
	if (whatsappState.isCreating) return null

	whatsappState.isCreating = true
	whatsappState.status = 'initializing'

	try {
		const chromePath = process.env.CHROME_PATH || undefined
		const client = await venom.create(
			'reminder-session',
			(base64Qr) => {
				const dataUrl = (typeof base64Qr === 'string' && base64Qr.startsWith('data:image'))
					? base64Qr
					: `data:image/png;base64,${base64Qr}`
				emitAndSave('qr', dataUrl)
			},
			(statusSession) => {
				emitAndSave('status', statusSession)
			},
			{
				multidevice: true,
				headless: true,
				browserPathExecutable: chromePath,
				browserArgs: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--no-first-run',
					'--no-zygote'
				]
			}
		)

		client.onStateChange((state) => {
			emitAndSave('status', state)
			if (state === 'CONNECTED') {
				emitAndSave('loggedIn')
			} else if (['DISCONNECTED', 'UNPAIRED', 'UNLAUNCHED', 'TIMEOUT'].includes(state)) {
				emitAndSave('loggedOut')
			}
		})

		whatsappState.client = client

		try {
			if (typeof client.isLoggedIn === 'function') {
				const ok = await client.isLoggedIn()
				if (ok) emitAndSave('loggedIn')
			}
		} catch (_) {}
		return client
	} catch (error) {
		console.error('venom init error:', error)
		emitAndSave('status', 'error')
		whatsappState.client = null
		return null
	} finally {
		whatsappState.isCreating = false
	}
}

module.exports = {
	initWhatsapp,
	getWhatsappState,
	onWhatsappEvent
}
