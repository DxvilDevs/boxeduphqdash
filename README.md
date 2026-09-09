# Boxed Up HQ

A GitHub Pages + Supabase production workspace for **Boxed Up Games**. It combines Notion-style tables with Trello-style drag-and-drop boards, while using the Boxed Up cardboard/yellow visual identity.

## Included

- Issue Tracking database
- Overarching To-Do Tracker
- Weekly Update Checklist
- Models Needed board
- Scripting Needed board
- Create additional tables/boards
- Drag cards between Not started / In progress / Done
- Reorder tracker sections in the sidebar
- Move tasks between trackers
- Assignees, due dates, priority, type, notes, effort and progress
- Realtime team collaboration through Supabase Realtime
- Email-locked team invite links
- Role-based permissions enforced by Supabase Row Level Security
- Protected Owner account: **dxvil6354@gmail.com**
- Default **Admin**, **Developer**, and **Viewer** roles
- Owner-editable permissions for Admin/Developer/Viewer and custom roles
- Installable PWA with the Boxed Up logo
- Due-date notifications for tasks assigned to the signed-in user

---

# 1. Create the Supabase project

Create a free Supabase project.

Open **SQL Editor**, paste the entire contents of:

```text
supabase/schema.sql
```

and run it.

The schema is also written to upgrade the first Boxed Up HQ schema, so if you already ran the old `schema.sql`, run this new file again.

## Authentication URL settings

In Supabase go to **Authentication -> URL Configuration**.

Set your Site URL to your deployed GitHub Pages URL, for example:

```text
https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY/
```

Add the same URL to the allowed Redirect URLs. If you use a custom domain, add that as well.

---

# 2. Add the GitHub secrets

Do **not** commit `config.js`.

In the GitHub repository open:

**Settings -> Secrets and variables -> Actions -> New repository secret**

Create:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

`SUPABASE_URL` is your Supabase project URL.

`SUPABASE_PUBLISHABLE_KEY` should be the browser-safe Supabase publishable key (`sb_publishable_...`).

If your Supabase project still only has the older anon key, you can instead create:

```text
SUPABASE_ANON_KEY
```

The deployment workflow accepts either key name, preferring `SUPABASE_PUBLISHABLE_KEY`.

### Important security detail

GitHub Secrets keep the values out of the **public repository and Git history**. During deployment, GitHub Actions creates `config.js` inside the Pages artifact.

The publishable/anon key is still visible to anyone using the deployed website through browser developer tools. That is expected for a Supabase browser app. Security is provided by the Row Level Security policies in `schema.sql`.

**Never use a Supabase secret key, `sb_secret_...`, or legacy `service_role` key in this website or the GitHub Pages build.**

---

# 3. Enable GitHub Pages through Actions

The included workflow is:

```text
.github/workflows/deploy.yml
```

In GitHub go to:

**Settings -> Pages -> Build and deployment -> Source -> GitHub Actions**

Push the project to the `main` branch.

The workflow will:

1. Read the Supabase values from GitHub Secrets.
2. Build a clean `dist/` folder.
3. Generate `dist/config.js` without committing it.
4. Deploy the site to GitHub Pages.

---

# 4. Create the Owner account

Sign up to the deployed HQ using:

```text
dxvil6354@gmail.com
```

After confirming the email if Supabase email confirmation is enabled, sign in.

Only this email can run the initial **Create Boxed Up HQ** bootstrap. It becomes the protected Owner account.

The Owner cannot be removed, demoted, or replaced through the website/API policies.

Other users cannot create their own HQ from this deployment. They must join through an invite created by the Owner or an Admin who has the Invite Members permission.

---

# Roles and permissions

The initial roles are:

| Role | Default access |
| --- | --- |
| Owner | Full access. Protected and locked to `dxvil6354@gmail.com`. |
| Admin | Tasks + trackers + team invites/member management. |
| Developer | Create/edit/delete tasks and create/edit trackers. |
| Viewer | Read-only. |

On **Team & Permissions**, the Owner can edit the permissions of every non-Owner role.

Editable permissions include:

- Create tasks
- Edit tasks / statuses / board movement
- Delete tasks
- Create trackers
- Edit/reorder trackers
- Delete trackers
- Invite members
- Manage member roles/remove members
- Workspace settings

The Owner can also create custom roles such as `Modeler`, `Scripter`, or `Investor` and choose their permissions.

These permissions are not just visual switches. The Supabase RLS policies check them server-side for database operations.

---

# Team invites

Open **Team & Permissions** and enter the team member's email.

Choose their role and click **Create invite**.

The HQ creates a link similar to:

```text
https://your-site.example/?invite=...
```

Send that link to the team member. They must sign in/sign up using the exact email address the invite was created for.

Owner access cannot be granted through an invite.

---

# PWA and notifications

The project includes:

```text
manifest.webmanifest
service-worker.js
assets/icon-*.png
assets/maskable-*.png
```

Once deployed over HTTPS by GitHub Pages, supported browsers can install Boxed Up HQ as an app.

A user can press **Enable reminders**. The app then syncs that user's assigned, incomplete tasks with due dates to the service worker.

Notifications are triggered when a task becomes:

- due in 2 days
- due tomorrow
- due today
- overdue

The service worker creates persistent OS/browser notifications and avoids repeatedly showing the same reminder stage.

### Background reminder support

When the HQ is open or reopened, reminders are checked automatically. The PWA also registers **Periodic Background Sync** on browsers that support it, allowing reminder checks while the installed app is not currently open.

Browser support for scheduled/periodic background work varies. A completely guaranteed notification at an exact time while every browser is fully closed would require a server-side Web Push scheduler rather than a purely static GitHub Pages site.

---

# Local development

For local testing only, copy:

```text
config.example.js
```

to:

```text
config.js
```

and put your project URL and publishable key in the local `config.js`.

`config.js` is included in `.gitignore`, so it will not be committed.

Use a local web server rather than opening `index.html` directly. For example:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

Add the localhost URL to your Supabase Authentication Redirect URLs if you test signup confirmation locally.

---

# Project structure

```text
boxed-up-hq/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── assets/
│   ├── logo.png
│   ├── icon-*.png
│   └── maskable-*.png
├── supabase/
│   └── schema.sql
├── .gitignore
├── .nojekyll
├── app.js
├── config.example.js
├── index.html
├── manifest.webmanifest
├── service-worker.js
├── styles.css
└── README.md
```
