# Session expiry demo (Razor Pages, .NET 10, Entra ID)

A stateless way to handle auth cookie expiry. The app warns before the cookie expires,
blocks the page once it has, and lets the user sign in again in a popup. Nothing reloads,
so an open modal keeps its unsaved input, and a pending save is retried after sign-in.

To make testing quick, the auth cookie lives for **120 s (sliding)** and the warning appears **45 s** before it expires.

## 1. Register the app in Entra ID

1. Go to Entra admin center → **App registrations** → **New registration**.
   - Supported account types: *Single tenant* is fine.
   - Redirect URI: platform **Web**, `https://localhost:5001/signin-oidc`
2. Under **Authentication**:
   - Front-channel logout URL: `https://localhost:5001/signout-oidc`
   - Under *Implicit grant and hybrid flows*, tick **ID tokens**. The app only signs users in
     and calls no APIs, so Microsoft.Identity.Web uses the `id_token` flow and needs no client secret.
3. Copy the **Directory (tenant) ID** and **Application (client) ID** into `appsettings.json`
   (or set them with `dotnet user-secrets set "AzureAd:ClientId" "..."`).

## 2. Run it

```bash
dotnet dev-certs https --trust   # once, if you haven't already
dotnet run --launch-profile https
```

Open https://localhost:5001. The panel on the right shows the session state, the expiry time,
the seconds left, and a log of every transition and request.

## 3. Test scenarios

| # | What to do | What you should see |
|---|-----------|---------------------|
| 1 | Do nothing for ~75 s | Warning toast with a countdown. **Stay signed in** sends a keep-alive and the countdown resets. The cookie is only re-issued after half the lifetime (60 s), which the log shows. |
| 2 | Open **New note**, type, untick *"Typing / clicking counts as activity"*, wait ~2 min | Blocking overlay on top of the modal. **Sign in again** opens a popup. Because your Entra SSO session is still active, it closes on its own after a moment. The overlay closes and your text is still there. |
| 3 | Like #2, but press **Save** while the overlay is up (or let it expire, then Save) | The save waits. After you sign in it is sent automatically and the note appears. |
| 4 | Click **Kill auth cookie**, then save a note | The server drops the auth cookie but the client still thinks it's valid. The save returns 401, the overlay opens with "server no longer accepts…", and after sign-in the save is retried. This is the same path you'd hit after data-protection keys rotate or the user signs out in another app. |
| 5 | Keep typing in the modal for > 2 min with the activity box ticked | No expiry. A keep-alive is sent at most every 20 s while you're active. |
| 6 | Open two tabs and let both reach the warning. Click **Stay signed in** in one | The warning disappears in the other tab too, because both read the same `auth_exp` cookie. |
| 7 | Block popups for localhost, let it expire, click **Sign in again** | Message about the blocked popup. **Sign in with redirect** saves the draft, does a full sign-in round trip, comes back, and reopens the modal with your text. |
| 8 | Let it expire, then click **Reload page** | The classic behaviour: a silent redirect to Entra and back. The draft is restored from `sessionStorage`. |
| 9 | Sign out of Entra elsewhere (e.g. myaccount.microsoft.com) or wait out a Conditional Access sign-in frequency, then trigger #2 | The popup shows a real sign-in prompt instead of closing on its own. Everything else works the same. |

## Where things live

- `Program.cs`
  - Cookie events (`OnSigningIn`, `OnCheckSlidingExpiration`, `OnSigningOut`) write and delete the readable `auth_exp` cookie (unix seconds).
  - `OnRedirectToIdentityProvider` returns **401** to script requests instead of redirecting them to Entra.
  - `/session/keepalive`, `/session/reauth`, `/session/done`, `/session/antiforgery`: none of these store anything on the server.
  - `/debug/kill-auth-cookie`: for testing only (`SessionDemo:EnableDebugEndpoints`).
- `wwwroot/js/session-ui.js`: the countdown, warning, overlay, popup sign-in, and `SessionUI.authFetch()` (which retries once after a 401).
- `wwwroot/js/notes.js`: an example page using `authFetch` and a `sessionStorage` draft.

## Before using it for real

- Set `ExpireSeconds`, `WarnSeconds` and `KeepAliveSeconds` to production values (e.g. 1800 / 120 / 300) and turn off `EnableDebugEndpoints`.
- Pin the `Microsoft.Identity.Web` package versions instead of using `3.*`.
- If you later call downstream APIs (`EnableTokenAcquisitionToCallDownstreamApi`), use a distributed token cache. Also map `MsalUiRequiredException` to a 401 for script requests, so the same overlay handles it.
