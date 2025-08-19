const fetchPolyfill = (typeof fetch !== 'undefined') ? fetch : ((...args) => import('node-fetch').then(({default: f}) => f(...args)))

const getNumber = async(req, res) => {
	const {id} = req.query
	const {startDate, endDate} = req.body

	try {
		const customers = await fetchPolyfill(`https://customer-sheet-server-production.up.railway.app/api/customers/get-customer-numbers?id=${id}`,{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				startDate,
				endDate
			})
		})
		const payload = await customers.json()

        console.log(payload)
		// Normalize into array of phone strings
		let list = []
		if (Array.isArray(payload?.data)) list = payload.data
		else if (Array.isArray(payload?.numbers)) list = payload.numbers
		else if (Array.isArray(payload)) list = payload

		const toPhoneString = (item) => {
			if (item == null) return null
			const raw = typeof item === 'string' ? item : (item.waOrFbId || item.phone || item.number || '')
			if (!raw) return null
			const trimmed = String(raw).trim()
			const digits = trimmed.replace(/\D+/g, '')
			if (!digits) return null
			// If contains '+' OR does not start with '0', assume already in international format
			if (trimmed.includes('+') || !digits.startsWith('0')) return '+' + digits
			// Otherwise, local format -> prefix with +88
			return '+88' + digits
		}

		const numbers = Array.from(new Set(
			(list || []).map(toPhoneString).filter(Boolean)
		))

		return res.status(200).json({ numbers })
	} catch (error) {
		console.log(error)
		res.status(500).json({message: 'Internal server error'})
	}


}

module.exports = getNumber