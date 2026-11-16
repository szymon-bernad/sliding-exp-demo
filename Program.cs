using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Identity.Web;
using Microsoft.Identity.Web.UI;
using SessionDemo;

var builder = WebApplication.CreateBuilder(args);

var demo = builder.Configuration.GetSection("SessionDemo").Get<SessionDemoOptions>() ?? new();
builder.Services.Configure<SessionDemoOptions>(builder.Configuration.GetSection("SessionDemo"));

// ---------------------------------------------------------------------------
// Authentication: Entra ID sign-in (OIDC) + auth cookie, no server-side session
// ---------------------------------------------------------------------------
builder.Services.AddAuthentication(OpenIdConnectDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApp(builder.Configuration.GetSection("AzureAd"));

builder.Services.Configure<CookieAuthenticationOptions>(
    CookieAuthenticationDefaults.AuthenticationScheme, o =>
{
    o.ExpireTimeSpan = TimeSpan.FromSeconds(demo.ExpireSeconds);
    o.SlidingExpiration = true;

    // Chain any handlers that are already registered (e.g. by Microsoft.Identity.Web).
    var prevSigningIn = o.Events.OnSigningIn;
    o.Events.OnSigningIn = async ctx =>
    {
        await prevSigningIn(ctx);
        // ExpiresUtc is already filled in by the cookie handler at this point.
        AuthExpCookie.Write(ctx.HttpContext,
            ctx.Properties.ExpiresUtc ?? DateTimeOffset.UtcNow.Add(ctx.Options.ExpireTimeSpan));
    };

    // Runs on every authenticated request. ShouldRenew = the handler is about to re-issue the cookie.
    var prevSliding = o.Events.OnCheckSlidingExpiration;
    o.Events.OnCheckSlidingExpiration = async ctx =>
    {
        await prevSliding(ctx);
        var issued = ctx.Properties.IssuedUtc!.Value;
        var expires = ctx.Properties.ExpiresUtc!.Value;
        var exp = ctx.ShouldRenew
            ? DateTimeOffset.UtcNow.Add(expires - issued)   // same formula the handler uses on renewal
            : expires;
        AuthExpCookie.Write(ctx.HttpContext, exp);
    };

    var prevSigningOut = o.Events.OnSigningOut;
    o.Events.OnSigningOut = async ctx =>
    {
        await prevSigningOut(ctx);
        AuthExpCookie.Delete(ctx.HttpContext);
    };
});

builder.Services.Configure<OpenIdConnectOptions>(
    OpenIdConnectDefaults.AuthenticationScheme, o =>
{
    // Script requests (fetch/XHR) get a 401 instead of a silent redirect to Entra.
    var prev = o.Events.OnRedirectToIdentityProvider;
    o.Events.OnRedirectToIdentityProvider = async ctx =>
    {
        if (IsScriptRequest(ctx.Request))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            ctx.Response.Headers["X-Session-Expired"] = "1";
            ctx.HandleResponse();
            return;
        }
        await prev(ctx);
    };
});

// Every endpoint requires a signed-in user unless marked [AllowAnonymous].
builder.Services.AddAuthorization(o => o.FallbackPolicy = o.DefaultPolicy);

builder.Services.AddRazorPages().AddMicrosoftIdentityUI();
builder.Services.AddSingleton<NotesStore>();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();      // before auth: static files don't touch (or slide) the cookie
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapRazorPages();
app.MapControllers();      // Microsoft.Identity.Web.UI sign-in / sign-out

// ---------------------------------------------------------------------------
// Session helper endpoints (stateless: they only read / re-issue the auth cookie)
// ---------------------------------------------------------------------------
var session = app.MapGroup("/session");

// Any authenticated request slides the cookie; this one just does nothing else.
session.MapPost("/keepalive", () => Results.NoContent());

// Opened in a popup (default) or as a full redirect with ?returnUrl=/some/page
session.MapGet("/reauth", (string? returnUrl) =>
{
    var target = IsLocalUrl(returnUrl) ? returnUrl! : "/session/done";
    return Results.Challenge(
        new AuthenticationProperties { RedirectUri = target },
        [OpenIdConnectDefaults.AuthenticationScheme]);
}).AllowAnonymous();

// Landing page of the popup: tell the opener we're back, then close.
session.MapGet("/done", () => Results.Content("""
    <!DOCTYPE html>
    <title>Signed in</title>
    <p>Signed in. You can close this window.</p>
    <script>
      if (window.opener) {
        window.opener.postMessage('session:reauthenticated', location.origin);
        window.close();
      } else {
        location.replace('/');
      }
    </script>
    """, "text/html"));

// Fresh antiforgery request token for the (possibly new) identity.
session.MapGet("/antiforgery", (IAntiforgery af, HttpContext ctx) =>
    Results.Ok(new { token = af.GetAndStoreTokens(ctx).RequestToken }));

// ---------------------------------------------------------------------------
// Debug only: remove the auth cookie but keep the auth_exp hint, so the client
// still thinks it's signed in. Simulates e.g. rotated data-protection keys.
// ---------------------------------------------------------------------------
if (demo.EnableDebugEndpoints)
{
    app.MapPost("/debug/kill-auth-cookie", async (HttpContext ctx) =>
    {
        var hint = ctx.Request.Cookies[AuthExpCookie.Name];
        await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        if (long.TryParse(hint, out var unix))
            AuthExpCookie.Write(ctx, DateTimeOffset.FromUnixTimeSeconds(unix)); // put the hint back
        return Results.NoContent();
    });
}

app.Run();

static bool IsScriptRequest(HttpRequest r)
{
    if (r.Headers.XRequestedWith == "XMLHttpRequest") return true;
    var mode = r.Headers["Sec-Fetch-Mode"].ToString();
    return mode.Length > 0 && mode != "navigate";
}

static bool IsLocalUrl(string? url) =>
    !string.IsNullOrEmpty(url) && url[0] == '/'
    && (url.Length == 1 || (url[1] != '/' && url[1] != '\\'));
