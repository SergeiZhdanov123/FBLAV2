# State High FBLA Chapter Hub (V2)

The chapter website with **no student accounts**. Anyone can open the hub and see the calendar, announcements, Google Forms, and study materials without signing in. Officers sign in to a separate console to run the chapter and the treasury.

V2 is a copy of FBLABudgeterApp with every student-account feature removed. The officer console is V1's console; the public hub is built from the design in `Design/`.

## What is where

| URL | What it is |
| --- | --- |
| `/` | Public chapter hub: Home, Calendar, Forms, Announcements, Meeting Resources, Study & Prep |
| `/about`, `/aboutfbla` | The About page (V1's About page, without the sign-up buttons) |
| `/officer` | Officer sign-in and the officer console |

## Running it

```sh
npm install
npm start          # http://localhost:8080
npm test
```

`.env` needs:

- `MONGODB_URI`: the Atlas connection string.
- `MONGODB_DB`: the database name. It defaults to `fbla_v2`, so V2 never reads or writes V1's `fbla` database.
- `EDIT_PASSWORD`: the chapter master password. It signs in with advisor rights, and President/Advisor can switch it off with strict sign-in.
- `SESSION_SECRET`: signs the session cookie.
- `ResendAPI` (or SMTP settings) and `MAIL_FROM`: optional. Without them, email features stay off.
- `GOOGLE_SHEETS_SERVICE_ACCOUNT` / `GOOGLE_SHEETS_BACKUP_ID`: optional recovery backup. **Use a new spreadsheet for V2.** Pointing V2 at V1's workbook would overwrite V1's backup.

To wipe the V2 database back to a clean state: `node reset-db.js`.

## Data from FBLABudgeterApp

`node scripts/migrate-from-v1.js` copies everything that isn't student data from V1's database (`fbla`) into V2's (`fbla_v2`). It only ever reads V1. With no flags it's a dry run that prints what would move. `--apply` copies into an empty V2 database. `--apply --replace` copies V1 again, overwriting the copied collections, including anything officers created in those collections in V2 since the last copy.

What it copies: officer accounts (password hashes unchanged, so everyone keeps their password), the calendar and the connected Google Calendar link, chapter-wide announcements, transactions (without member links), deposit slips, purchase orders, resources, the officer calendar, settings that still apply, the officer part of the activity log, and the id counters.

What it leaves behind: members, dues, attendance, points, forms and their responses, notifications, the forum, buddy groups, messages, and anything aimed at specific members.

## Who can do what

Everyone uses the hub without an account. Officer accounts have one of four roles:

| | Officer | Treasurer | President / Advisor |
| --- | --- | --- | --- |
| Events, calendar, officer calendar, announcements, Google Forms, resources, customization, email to the officer team | yes | yes | yes |
| View the treasury | yes | yes | yes |
| Change the balance, record transactions, deposit slips, purchase orders | no | yes | yes |
| Add officers, change roles, set officer passwords, strict sign-in, backups, system health | no | no | yes |

## What changed from FBLABudgeterApp

Removed, because they need student accounts or store student information: member sign-up and sign-in, the member roster and directory, dues per member, event attendees and per-student payments, point tiers, RSVPs, event sign-up teams, points and the approval queue, QR attendance and the kiosk, tasks, committees, the custom forms builder and its responses, the forum, buddy groups, the contact-officer inbox, in-app notifications, the weekly digest, member onboarding, and the school-year rollover.

Added or changed:

- **Google Forms** tab (Communication): paste a Google Form link, optionally tie it to an event and a respond-by date, and it appears on the hub's Forms page. Responses stay in Google.
- **Events** keep their dates, costs, payment due dates, and countdown banner, and gained an optional start time and location. Payment due dates show on the public calendar for everyone.
- **Announcements** are public and have a category (used by the hub's filter tabs). They are no longer emailed to anyone.
- **Calendar** items gained an optional location. The Google Calendar (iCal link) sync still works and now brings over each event's location too.
- **Study & Prep**: visitors pick a competitive event and see the resources tagged with it. Officers edit the event list in Customization.
- **Email** now goes to the officer team only.
- Transactions no longer link to a member (only to an event).

## MCP server

`mcp/fbla-mcp.js` lets an agent operate the hub (list/add events, calendar items, announcements, Google Forms, transactions, and Google Calendar sync). It has no delete tools. `.mcp.json` registers it.
