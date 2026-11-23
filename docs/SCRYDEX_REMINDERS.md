# Scrydex renewal + low-credit reminders (client guide)

The Scrydex plan is paid with an American Express card that does **not** auto-renew, so someone must pay by hand each cycle. This feature emails you before each renewal and when credits run low. Everything is set with `.env` values; no code changes.

## Settings (server `.env` on the Droplet, `/opt/dojo/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SCRYDEX_REMINDER_ENABLED` | off | `true` turns it on. Anything else = off. Keep it off on staging. |
| `SCRYDEX_RENEWAL_DATE` | none | A renewal date, `YYYY-MM-DD`. A past date is fine; the app rolls it forward. |
| `SCRYDEX_RENEWAL_CYCLE` | `monthly` | `monthly` or `yearly`. Same day each cycle; if the day does not exist the month's last day is used (31 Jan -> 28/29 Feb -> 31 Mar). |
| `SCRYDEX_REMINDER_TZ` | `Asia/Kolkata` | Timezone that decides what "today" is. |
| `SCRYDEX_REMINDER_DAYS_BEFORE` | `7,3,1,0` | Email on these days before renewal (0 = renewal day). |
| `SCRYDEX_LOW_CREDIT_PERCENT` | `20,5` | Email when remaining credits fall to or below these percentages, once per level per billing cycle (only the lowest newly crossed level is sent). Empty = no credit alerts. Needs `SCRYDEX_LIVE_CREDITS_APPROVED=true`, because reading usage costs 1 Scrydex credit (at most about once an hour). |
| `SCRYDEX_REMINDER_TO` | `dojo.collect@nodwin.com` | Comma-separated recipients. |
| `SCRYDEX_PLAN_LABEL` | empty | Plan name shown in the email (max 80 characters). |

A wrong value never breaks the app. The job just reports `not configured / invalid: <reason>` and sends nothing.

## Examples

- Renews on the 15th every month, remind 7, 3, 1 days before and on the day:
  `SCRYDEX_REMINDER_ENABLED=true`, `SCRYDEX_RENEWAL_DATE=2026-12-15`
- Yearly plan, only remind 14 and 2 days before and on the day, one credit alert at 10%:
  `SCRYDEX_RENEWAL_CYCLE=yearly`, `SCRYDEX_REMINDER_DAYS_BEFORE=14,2,0`, `SCRYDEX_LOW_CREDIT_PERCENT=10`

## Check your settings without sending anything

```bash
curl -fsS -H 'Authorization: Bearer <CRON_SECRET>' 'http://127.0.0.1:3000/api/cron/scrydex-reminder?dryRun=1'
```

The JSON shows `nextRenewal`, `daysUntil`, the credit reading, what would be sent (`wouldSend`) and a `reason`. Nothing is sent or recorded, and no Scrydex credit is spent: the credit reading comes from the last cached value (refreshed by the daily run), so it shows as unavailable until the first real run has happened. The same settings are visible (read-only) on the **Scrydex billing** card at the top of the `/admin` page.

## Daily trigger (Droplet host crontab)

The app does not schedule itself and `vercel.json` has no crons, so add this on the Droplet (`crontab -e` as root). 03:30 UTC = 09:00 India time:

```cron
30 3 * * * curl -fsS -H 'Authorization: Bearer <CRON_SECRET>' http://127.0.0.1:3000/api/cron/scrydex-reminder >> /var/log/scrydex-reminder.log 2>&1
```

`<CRON_SECRET>` is the `CRON_SECRET` value from `/opt/dojo/.env`. The prod app listens on `127.0.0.1:3000`. The job can run any number of times a day; each email is only sent once.

Note: the existing price-refresh cron (`/api/cron/refresh-owned-prices`) also only runs if a crontab entry exists. If you want it, add (03:00 UTC):

```cron
0 3 * * * curl -fsS -H 'Authorization: Bearer <CRON_SECRET>' http://127.0.0.1:3000/api/cron/refresh-owned-prices >> /var/log/refresh-owned-prices.log 2>&1
```

## After each payment

Nothing, if the billing date stays the same. If Scrydex moves your billing date, set `SCRYDEX_RENEWAL_DATE` to the new date and run `docker compose up -d app` in `/opt/dojo` to apply the `.env` change.
