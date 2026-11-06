---
title: Email reminders
description: "Also get every reminder as an email, by pointing Mitra at an SMTP server."
---

Reminders reach your devices as [push notifications](reminders.md). Mitra can also mail each reminder, which suits a shared calendar, a device that has no push, or anyone who lives in their inbox. Email is an addition: push keeps working exactly as before, and an instance without the settings below behaves as it always did.

> This is a fork addition. Upstream Mitra doesn't send email.

## Turn it on

Set these environment variables on the server. Email is on once a host and at least one valid recipient are set.

| Variable | Default | What it does |
| --- | --- | --- |
| `MITRA_SMTP_HOST` | | The SMTP server, for example `smtp.gmail.com`. Required. |
| `MITRA_SMTP_PORT` | `587` | The server's port. |
| `MITRA_SMTP_SECURE` | `true` on port 465, else `false` | `true` connects over TLS from the start (port 465). `false` starts plain and upgrades with STARTTLS, which Mitra insists on whenever it logs in. |
| `MITRA_SMTP_USER` | | The login, where the server needs one. |
| `MITRA_SMTP_PASS` | | The password. For Gmail, an [app password](https://support.google.com/accounts/answer/185833). |
| `MITRA_SMTP_FROM` | the user | The sender, for example `Mitra <you@example.com>`. |
| `MITRA_REMINDER_EMAILS` | | Who gets the mail: addresses separated by commas. Required. |

Mitra has one account here, so every reminder goes to every address listed: one message to all of them. Anything in the list that isn't an address is ignored.

```yaml
environment:
  MITRA_URL: 'https://cal.example.com'
  TZ: America/Chicago
  MITRA_SMTP_HOST: smtp.gmail.com
  MITRA_SMTP_PORT: '465'
  MITRA_SMTP_SECURE: 'true'
  MITRA_SMTP_USER: you@gmail.com
  MITRA_SMTP_PASS: abcdefghijklmnop
  MITRA_SMTP_FROM: 'Mitra <you@gmail.com>'
  MITRA_REMINDER_EMAILS: you@gmail.com,partner@example.com
```

Keep the password out of the compose file; pass the variables in with an `env_file` that only the server can read.

## What the mail says

The subject reads `Reminder: Dentist at Fri, Nov 6, 3:30 PM`, or `… due …` for a task and `… on Sat, Nov 7` for an all-day entry. The body gives the full date and time, the location and the description when there are any, and a link back to the entry when `MITRA_URL` is set. There is a plain-text part and a simple HTML part; whatever you wrote is escaped in the HTML.

Times are written in the time zone of the device that last registered for push, else `TZ`, else `America/Chicago`. All-day and floating entries are written as they're stored, with no conversion.

## When it goes wrong

A mail that can't be sent is logged as a warning and dropped, and push is not affected. A temporary failure, such as a timeout, is tried once more after 30 seconds. A refusal that repeating can't mend, such as a wrong password, is not retried. The password never reaches the log.

Mitra sends the mail when the reminder fires, from the same timer as the push. If the server was down when a reminder was due, the same grace applies as for push: reminders more than 15 minutes late are skipped.
