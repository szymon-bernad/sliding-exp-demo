using System.Globalization;

namespace SessionDemo;

public sealed class SessionDemoOptions
{
    /// <summary>Auth cookie lifetime (sliding). Short so you can watch the flow.</summary>
    public int ExpireSeconds { get; set; } = 120;

    /// <summary>Show the "you'll be signed out" warning this many seconds before expiry.</summary>
    public int WarnSeconds { get; set; } = 45;

    /// <summary>At most one keep-alive per this interval while the user is active.</summary>
    public int KeepAliveSeconds { get; set; } = 20;

    /// <summary>Exposes /debug/kill-auth-cookie. Turn off outside of testing.</summary>
    public bool EnableDebugEndpoints { get; set; } = true;
}

/// <summary>
/// Readable companion cookie holding only the auth cookie's expiry (unix seconds),
/// so the browser can count down without asking the server.
/// </summary>
public static class AuthExpCookie
{
    public const string Name = "auth_exp";

    public static void Write(HttpContext http, DateTimeOffset expiresUtc) =>
        http.Response.Cookies.Append(
            Name,
            expiresUtc.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
            new CookieOptions
            {
                HttpOnly = false,
                Secure = true,
                SameSite = SameSiteMode.Lax,
                Path = "/",
                Expires = expiresUtc,
                IsEssential = true
            });

    public static void Delete(HttpContext http) =>
        http.Response.Cookies.Delete(Name, new CookieOptions
        {
            Secure = true,
            SameSite = SameSiteMode.Lax,
            Path = "/"
        });
}

public sealed record Note(int Id, string Title, string Body, string Author, DateTimeOffset Created);

public sealed record NoteInput(string? Title, string? Body);

/// <summary>In-memory data so the demo has something to save. Not session state.</summary>
public sealed class NotesStore
{
    private readonly List<Note> _notes = [];
    private readonly Lock _lock = new();
    private int _nextId = 1;

    public IReadOnlyList<Note> All()
    {
        lock (_lock) return _notes.OrderByDescending(n => n.Id).ToList();
    }

    public Note Add(string title, string body, string author)
    {
        lock (_lock)
        {
            var note = new Note(_nextId++, title, body, author, DateTimeOffset.UtcNow);
            _notes.Add(note);
            return note;
        }
    }
}
