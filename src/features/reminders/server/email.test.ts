import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TimeZone } from '#features/time/TimeZone.js'
import { ReminderNotification } from '../ReminderNotification.js'
import { composeReminderEmail, emailConfigOf, ReminderEmail, type EmailTransport, type ReminderMessage } from './email.js'

const chicago = TimeZone.of('America/Chicago')
const url = new URL('https://cal.draconis.io')

// 2026-11-06 15:30 in Chicago (CST, UTC-6) is 21:30 UTC.
const start = Date.UTC(2026, 10, 6, 21, 30)
const now = Date.UTC(2026, 10, 6, 21, 0)

const event = (facts: Partial<ConstructorParameters<typeof ReminderNotification>[0]> = {}) => new ReminderNotification({
	heading: 'Dentist',
	tag: 'a|10',
	kind: 'event',
	timestamp: start,
	when: { start, end: start + 3_600_000 },
	entry: { id: 'abc__1' },
	...facts,
})

const configured = {
	MITRA_SMTP_HOST: 'smtp.example.com',
	MITRA_SMTP_PORT: '465',
	MITRA_SMTP_SECURE: 'true',
	MITRA_SMTP_USER: 'sender@example.com',
	MITRA_SMTP_PASS: 'hunter2-secret',
	MITRA_SMTP_FROM: 'Mitra <sender@example.com>',
	MITRA_REMINDER_EMAILS: 'phil@example.com, kim@example.com',
}

describe('emailConfigOf', () => {
	it('is off without SMTP settings, leaving reminders as they were', () => {
		assert.equal(emailConfigOf({}), undefined)
		assert.equal(emailConfigOf({ MITRA_REMINDER_EMAILS: 'phil@example.com' }), undefined)
		assert.equal(emailConfigOf({ ...configured, MITRA_SMTP_HOST: '' }), undefined)
	})

	it('is off without a recipient', () => {
		assert.equal(emailConfigOf({ ...configured, MITRA_REMINDER_EMAILS: ' , ' }), undefined)
		assert.equal(emailConfigOf({ ...configured, MITRA_REMINDER_EMAILS: undefined }), undefined)
	})

	it('reads the settings, splitting recipients and dropping what is no address or repeated', () => {
		const config = emailConfigOf({ ...configured, MITRA_REMINDER_EMAILS: 'phil@example.com, nonsense, Phil@Example.com ;kim@example.com' })
		assert.deepEqual(config?.recipients, ['phil@example.com', 'kim@example.com'])
		assert.equal(config?.host, 'smtp.example.com')
		assert.equal(config?.port, 465)
		assert.equal(config?.secure, true)
		assert.equal(config?.user, 'sender@example.com')
		assert.equal(config?.from, 'Mitra <sender@example.com>')
	})

	it('defaults the sender to the user, the port to 587, and secure to port 465 only', () => {
		const { MITRA_SMTP_PORT: _port, MITRA_SMTP_SECURE: _secure, MITRA_SMTP_FROM: _from, ...rest } = configured
		const plain = emailConfigOf(rest)
		assert.equal(plain?.port, 587)
		assert.equal(plain?.secure, false)
		assert.equal(plain?.from, 'sender@example.com')
		assert.equal(emailConfigOf({ ...rest, MITRA_SMTP_PORT: '465' })?.secure, true)
	})

	it('never shows the password when printed', () => {
		const config = emailConfigOf(configured)
		assert.doesNotMatch(JSON.stringify(config), /hunter2/)
		assert.doesNotMatch(String(config), /hunter2/)
	})
})

describe('composeReminderEmail', () => {
	it('names the entry and its time in the reader\'s zone in the subject', () => {
		const { subject } = composeReminderEmail(event(), { timeZone: chicago, now, url })
		assert.match(subject, /^Reminder: Dentist at /)
		assert.match(subject, /3:30\s?PM/)
		assert.doesNotMatch(subject, /9:30/)
	})

	it('words a task by its due time', () => {
		const { subject } = composeReminderEmail(event({ kind: 'task', heading: 'Pay rent', when: { end: start, due: true } }), { timeZone: chicago, now, url })
		assert.match(subject, /^Reminder: Pay rent due /)
	})

	it('words an all-day entry by its day, read in UTC as it is stored', () => {
		const day = Date.UTC(2026, 10, 7)
		const { subject, text } = composeReminderEmail(event({ heading: 'Birthday', when: { start: day, end: day + 86_400_000, allDay: true } }), { timeZone: chicago, now, url })
		assert.match(subject, /^Reminder: Birthday on .*Nov 7/)
		assert.match(text, /All day/)
	})

	it('gives the time, location and notes in the text, and a link back to the entry', () => {
		const { text } = composeReminderEmail(event({ location: 'Main St Dental' }), { timeZone: chicago, notes: 'Bring the form', now, url })
		assert.match(text, /Dentist/)
		assert.match(text, /Friday, November 6, 2026, 3:30.*4:30.*PM/)
		assert.match(text, /Main St Dental/)
		assert.match(text, /Bring the form/)
		assert.match(text, /https:\/\/cal\.draconis\.io\/\?date=2026-11-06&selected=abc__1/)
	})

	it('leaves out the link without an address for the instance', () => {
		const { text, html } = composeReminderEmail(event(), { timeZone: chicago, now })
		assert.doesNotMatch(text, /https?:\/\//)
		assert.doesNotMatch(html, /<a /)
	})

	it('escapes everything the user wrote in the HTML', () => {
		const { html } = composeReminderEmail(event({ heading: '<script>alert(1)</script> & "co"', location: '<img src=x onerror=alert(2)>' }), {
			timeZone: chicago, notes: '<b>bold</b>\nsecond line', now, url,
		})
		assert.doesNotMatch(html, /<script>|<img |<b>/)
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;co&quot;/)
		assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/)
	})

	it('keeps a heading from adding mail headers through the subject', () => {
		const { subject } = composeReminderEmail(event({ heading: 'Hi\r\nBcc: attacker@example.com' }), { timeZone: chicago, now, url })
		assert.doesNotMatch(subject, /[\r\n]/)
	})

	it('shortens long notes', () => {
		const { text } = composeReminderEmail(event(), { timeZone: chicago, notes: 'x'.repeat(5000), now, url })
		assert.ok(text.length < 2500)
	})

	it('names an untitled entry', () => {
		assert.match(composeReminderEmail(event({ heading: '' }), { timeZone: chicago, now, url }).subject, /^Reminder: Untitled at /)
	})
})

describe('ReminderEmail', () => {
	const recording = (failures: Array<unknown> = []) => {
		const sent = new Array<ReminderMessage>()
		const transport: EmailTransport = {
			sendMail(message) {
				const failure = failures.shift()
				if (failure) {
					return Promise.reject(failure instanceof Error ? failure : new Error(String(failure)))
				}
				sent.push(message)
				return Promise.resolve({})
			},
		}
		return { sent, transport }
	}
	const options = (transport: EmailTransport) => ({ transport, retryDelay: 0, url })
	const config = emailConfigOf(configured)!
	const logs = () => {
		const lines = new Array<string>()
		const log = { info: (...a: Array<unknown>) => lines.push(a.join(' ')), warn: (...a: Array<unknown>) => lines.push(a.join(' ')) }
		return { lines, log }
	}

	it('sends nothing, and builds no transport, when not configured', async () => {
		let built = false
		const email = new ReminderEmail(undefined, { createTransport: () => { built = true; return { sendMail: () => Promise.resolve({}) } } })
		assert.equal(email.enabled, false)
		await email.send(event(), { timeZone: chicago })
		assert.equal(built, false)
	})

	it('sends one message to all recipients, with text and HTML', async () => {
		const { sent, transport } = recording()
		await new ReminderEmail(config, options(transport)).send(event(), { timeZone: chicago, notes: 'n' })
		assert.equal(sent.length, 1)
		assert.deepEqual(sent[0]!.to, ['phil@example.com', 'kim@example.com'])
		assert.equal(sent[0]!.from, 'Mitra <sender@example.com>')
		assert.match(sent[0]!.subject, /^Reminder: Dentist/)
		assert.ok(sent[0]!.text && sent[0]!.html)
	})

	it('defaults the zone to America/Chicago', async () => {
		const { sent, transport } = recording()
		await new ReminderEmail(config, options(transport)).send(event(), {})
		assert.match(sent[0]!.subject, /3:30\s?PM/)
	})

	it('retries a transient failure once', async () => {
		const { sent, transport } = recording([Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })])
		await new ReminderEmail(config, options(transport)).send(event(), {})
		assert.equal(sent.length, 1)
	})

	it('gives up after one retry, without throwing', async () => {
		let attempts = 0
		const transport: EmailTransport = { sendMail: () => { attempts++; return Promise.reject(new Error('down')) } }
		const { log, lines } = logs()
		await new ReminderEmail(config, { ...options(transport), log }).send(event(), {})
		assert.equal(attempts, 2)
		assert.ok(lines.some(line => /failed/.test(line)))
	})

	it('does not retry what the server refused for good', async () => {
		let attempts = 0
		const transport: EmailTransport = { sendMail: () => { attempts++; return Promise.reject(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 })) } }
		await new ReminderEmail(config, { ...options(transport), log: logs().log }).send(event(), {})
		assert.equal(attempts, 1)
	})

	it('never logs credentials, even when an error carries them', async () => {
		const transport: EmailTransport = {
			sendMail: () => Promise.reject(Object.assign(new Error('failed for sender@example.com with hunter2-secret'), { command: 'AUTH', auth: { pass: 'hunter2-secret' } })),
		}
		const { log, lines } = logs()
		await new ReminderEmail(config, { ...options(transport), log }).send(event(), {})
		assert.ok(lines.length > 0)
		assert.doesNotMatch(lines.join('\n'), /hunter2/)
	})

	it('does not throw when composing fails', async () => {
		const { transport } = recording()
		await new ReminderEmail(config, { ...options(transport), log: logs().log }).send(event({ when: { start: Number.NaN } }), { timeZone: chicago })
	})
})
