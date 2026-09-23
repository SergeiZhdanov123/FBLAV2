# State High FBLA — design preview

A static, interactive adaptation of the existing FBLABudgeterApp member hub, with a public chapter website and a separate officer workspace. The original stylesheet is copied unchanged into `original.css`; the FBLA logo, Inter typography, sidebar, dashboard cards, countdown banner, and mobile bottom navigation are reused. `styles.css` contains the account-free prototype adaptations. Built with plain HTML, CSS, and JavaScript. No dependencies, API, database, authentication, analytics, or persistent storage.

## View it

Open `index.html` directly, or run:

```sh
cd /Users/sergeizhdanov/FBLAappV2/Design
node server.js
```

Then visit http://localhost:4173. The server only serves local static files.

## Explore

- Chapter home: next meeting, a countdown, announcements, dates, and resource shortcuts.
- Calendar: month navigation, list view, event details, and example `.ics` downloads.
- Announcements: category filters and full announcement dialogs.
- Meeting Resources: search and filters for meeting slides and guides.
- Forms: a separate page of example Google Forms links.
- Competition prep: type an event name to filter the list, then select it for sample preparation materials. Nothing is saved or registered.
- About: a public introduction to the chapter.
- Officer sign in: opens a visual sign-in concept. Leave the fields empty and select **Preview Officer Console**. Add or edit sample announcements, events, and resources to see public pages update in the current tab. Reloading restores the sample data.

All dates, updates, preparation notes, and resource contents are illustrative. Resource cards open local examples, not live Google Forms or slide decks. Links entered in the officer preview are held in memory only; they do not publish or connect external resources. No student accounts, student records, signup flows, committees, balances, or personalized reminders are included.

Accessibility features include semantic landmarks and headings, keyboard controls, visible focus, a skip link, labeled fields, native modal dialogs, reduced-motion support, and responsive layouts. The original FBLABudgeterApp is untouched.
