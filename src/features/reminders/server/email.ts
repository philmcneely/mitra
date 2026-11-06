import { createTransport } from 'nodemailer'
import { createLogger } from '#infrastructure/logging/Logger.js'
import { environment } from '#infrastructure/server/Environment.js'
import { TimeZone } from '#features/time/TimeZone.js'
import type { ReminderFacts, ReminderNotification } from '../ReminderNotification.js'

/**
 * Reminders by e-mail, beside web push and never instead of it: when a reminder fires and SMTP is set up
 * (`docs/email-reminders.md`), the same moment is mailed to the addresses the operator named. Without those
 * variables nothing here runs. A failure is logged and swallowed, as a reminder must not hang on a mail server.
 */

const logger = createLogger('EmailReminders')

type Variables = Readonly<Record<string, string | undefined>>

const DEFAULT_ZONE = 'America/Chicago'
const NOTES_MAX = 1000
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

/** What the operator set (`MITRA_SMTP_*`, `MITRA_REMINDER_EMAILS`); the password is kept out of anything that prints it. */
export class EmailConfig {
	readonly #pass?: string

	constructor(
		readonly host: string,
		readonly port: number,
		readonly secure: boolean,
		readonly user: string | undefined,
		pass: string | undefined,
		readonly from: string,
		readonly recipients: ReadonlyArray<string>,
	) {
		this.#pass = pass
	}

	get pass() {
		return this.#pass
	}

	toJSON() {
		return { host: this.host, port: this.port, secure: this.secure, user: this.user, from: this.from, recipients: this.recipients }
	}
}

/** The e-mail settings the variables describe, none unless a host and at least one valid recipient are named. */
export function emailConfigOf(variables: Variables): EmailConfig | undefined {
	const host = variables.MITRA_SMTP_HOST?.trim()
	const recipients = [...new Set((variables.MITRA_REMINDER_EMAILS ?? '').split(/[,;\s]+/)
		.map(address => address.trim().toLowerCase())
		.filter(address => ADDRESS.test(address)))]
	if (!host || recipients.length === 0) {
		return undefined
	}
	const port = Number(variables.MITRA_SMTP_PORT) || 587
	const secure = variables.MITRA_SMTP_SECURE?.trim()
		? ['true', '1', 'yes', 'on'].includes(variables.MITRA_SMTP_SECURE.trim().toLowerCase())
		: port === 465
	const user = variables.MITRA_SMTP_USER?.trim() || undefined
	const from = variables.MITRA_SMTP_FROM?.trim() || user
	if (!from) {
		return undefined
	}
	return new EmailConfig(host, port, secure, user, variables.MITRA_SMTP_PASS || undefined, from, recipients)
}

export interface ReminderMessage {
	from: string
	to: Array<string>
	subject: string
	text: string
	html: string
}

export interface EmailTransport {
	sendMail(message: ReminderMessage): Promise<unknown>
}

export interface ComposeOptions {
	timeZone?: TimeZone
	/** The entry's description. */
	notes?: string
	/** The instance's public address, which the mail links back to. */
	url?: URL
	now?: number
}

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[character]!)
}

/** One line, as a header must be, with no-break spaces made plain. */
function oneLine(value: string) {
	return value.replace(/[\u202F\u00A0]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The moment a reminder is about: a task's due date, else the start. */
function anchorOf({ when }: ReminderFacts) {
	return when === undefined ? undefined : when.due ? when.end : when.start ?? when.end
}

const ReminderEmailLink = {
	/** The address of `path` on the instance, none if it would lead anywhere else. */
	of(path: string, base: URL) {
		const link = new URL(path, base)
		return link.origin === base.origin ? link.toString() : undefined
	},
}

/** The subject, the text and the HTML of a reminder, with the time read in the reader's zone. */
export function composeReminderEmail(notification: ReminderNotification, options: ComposeOptions = {}) {
	const { facts } = notification
	const { when, location } = facts
	const timeZone = options.timeZone ?? TimeZone.of(DEFAULT_ZONE)
	const now = options.now ?? Date.now()
	const anchor = anchorOf(facts)
	if (!when || anchor === undefined || !Number.isFinite(anchor)) {
		throw new RangeError('The reminder has no time.')
	}

	// All-day and floating values encode wall-clock time as UTC, so they are read as such.
	const zone = when.allDay || when.floating ? TimeZone.UTC : timeZone
	const format = (style: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', { timeZone: zone.id, ...style })
	const day = format({ weekday: 'short', month: 'short', day: 'numeric' })
	const dayAndClock = format({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
	const full = format({ dateStyle: 'full', timeStyle: 'short' })

	const title = oneLine(facts.heading) || 'Untitled'
	const [verb, instant] = when.allDay
		? [when.due ? 'due' : 'on', day.format(anchor)]
		: [when.due ? 'due' : 'at', dayAndClock.format(anchor)]
	const subject = oneLine(`Reminder: ${title} ${verb} ${instant}`)

	const range = !when.due && !when.allDay && when.start !== undefined && when.end !== undefined && when.end > when.start
	const timing = when.allDay
		? `${format({ dateStyle: 'full' }).format(anchor)} (All day)`
		: range ? full.formatRange(when.start!, when.end!) : full.format(anchor)
	const timeLine = oneLine(when.due ? `Due ${timing}` : timing)

	const notes = options.notes?.replace(/\r\n?/g, '\n').trim()
	const shortNotes = notes ? notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX)}…` : notes : undefined
	const link = options.url ? ReminderEmailLink.of(notification.for({ locale: 'en', timeZone }, now).url, options.url) : undefined
	const kind = facts.kind === 'task' ? 'Task' : 'Event'

	const text = [
		`${kind} reminder: ${title}`,
		timeLine,
		location ? `Where: ${location}` : undefined,
		shortNotes ? `\n${shortNotes}` : undefined,
		link ? `\nOpen in Mitra: ${link}` : undefined,
	].filter(line => line !== undefined).join('\n') + '\n'

	const row = (content: string) => `<p style="margin:0 0 8px">${content}</p>`
	const html = [
		'<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.45;color:#1c1c1e;max-width:32rem">',
		`<p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6b6b70">${kind} reminder</p>`,
		`<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(title)}</h1>`,
		row(escapeHtml(timeLine)),
		location ? row(`<strong>Where:</strong> ${escapeHtml(location)}`) : '',
		shortNotes ? `<div style="margin:12px 0;padding:8px 12px;border-inline-start:3px solid #c7c7cc;white-space:pre-wrap">${escapeHtml(shortNotes)}</div>` : '',
		link ? row(`<a href="${escapeHtml(link)}">Open in Mitra</a>`) : '',
		'</div>',
	].filter(Boolean).join('\n')

	return { subject, text, html }
}

interface Log {
	info(...message: Array<unknown>): void
	warn(...message: Array<unknown>): void
}

export interface ReminderEmailOptions {
	/** Replaces the SMTP connection, for tests. */
	transport?: EmailTransport
	createTransport?: (config: EmailConfig) => EmailTransport
	/** Milliseconds before the one retry. */
	retryDelay?: number
	url?: URL
	/** The zone a reminder is worded in when no device has told one. */
	defaultZone?: TimeZone
	log?: Log
}

export interface SendOptions {
	timeZone?: TimeZone
	notes?: string
}

/** Codes of failures a second attempt cannot mend: the server refused the login, the sender or the message. */
const PERMANENT = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE'])

export class ReminderEmail {
	private transport?: EmailTransport
	private readonly log: Log
	/** Mail goes one message at a time, so a burst of reminders is one connection after another, not a flood of them. */
	private queue: Promise<void> = Promise.resolve()

	constructor(private readonly config: EmailConfig | undefined, private readonly options: ReminderEmailOptions = {}) {
		this.log = options.log ?? logger
		this.transport = options.transport
		if (config) {
			this.log.info(`Email reminders on: ${config.host}:${config.port} to ${config.recipients.length} recipient(s).`)
		}
	}

	get enabled() {
		return this.config !== undefined
	}

	/** Mails the reminder if e-mail is on; never rejects, never tries more than twice. */
	send(notification: ReminderNotification, options: SendOptions): Promise<void> {
		if (!this.config) {
			return Promise.resolve()
		}
		return this.queue = this.queue.then(() => this.mail(this.config!, notification, options))
	}

	private async mail(config: EmailConfig, notification: ReminderNotification, { timeZone, notes }: SendOptions) {
		const heading = oneLine(notification.facts.heading)
		try {
			const content = composeReminderEmail(notification, { timeZone: timeZone ?? this.options.defaultZone, notes, url: this.options.url })
			const message: ReminderMessage = { from: config.from, to: [...config.recipients], ...content }
			await this.deliver(config, message, heading)
		} catch (error) {
			this.log.warn(`Email reminder for "${heading}" failed: ${this.describe(config, error)}`)
		}
	}

	private async deliver(config: EmailConfig, message: ReminderMessage, heading: string) {
		const transport = this.transport ??= this.options.createTransport?.(config) ?? ReminderEmail.smtp(config)
		for (let attempt = 1; ; attempt++) {
			try {
				await transport.sendMail(message)
				this.log.info(`Email reminder sent: "${heading}" to ${message.to.length} recipient(s).`)
				return
			} catch (error) {
				if (attempt >= 2 || !ReminderEmail.transient(error)) {
					throw error
				}
				this.log.warn(`Email reminder for "${heading}" failed (${this.describe(config, error)}); retrying once.`)
				await new Promise(resolve => setTimeout(resolve, this.options.retryDelay ?? 30_000))
			}
		}
	}

	private static smtp(config: EmailConfig): EmailTransport {
		return createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			// Never send a login in the clear.
			requireTLS: !config.secure && !!config.user,
			auth: config.user ? { user: config.user, pass: config.pass } : undefined,
			connectionTimeout: 15_000,
			greetingTimeout: 15_000,
			socketTimeout: 30_000,
			disableFileAccess: true,
			disableUrlAccess: true,
		})
	}

	private static transient(error: unknown) {
		const { code, responseCode } = error as { code?: string, responseCode?: number }
		return !(code && PERMANENT.has(code)) && !(typeof responseCode === 'number' && responseCode >= 500)
	}

	/** What may be logged of a failure: its code and message, never the error itself, which may hold the login. */
	private describe(config: EmailConfig, error: unknown) {
		const { code, responseCode } = (error ?? {}) as { code?: string, responseCode?: number }
		let message = error instanceof Error ? error.message : String(error)
		if (config.pass) {
			message = message.split(config.pass).join('***')
		}
		return [code, responseCode, message].filter(part => part !== undefined && part !== '').join(' ')
	}
}

/** This process's: on only when the environment sets up SMTP. */
export const reminderEmail = new ReminderEmail(emailConfigOf(process.env), {
	url: environment.url,
	defaultZone: TimeZone.parse(process.env.TZ),
})
