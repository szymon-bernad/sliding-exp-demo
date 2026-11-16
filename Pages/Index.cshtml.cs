using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace SessionDemo.Pages;

public class IndexModel(NotesStore store) : PageModel
{
    public IReadOnlyList<Note> Notes { get; private set; } = [];

    public void OnGet() => Notes = store.All();

    // Called with fetch: POST /?handler=Save, JSON body, RequestVerificationToken header.
    public IActionResult OnPostSave([FromBody] NoteInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Title))
            return BadRequest(new { error = "Title is required." });

        var note = store.Add(input.Title.Trim(), input.Body?.Trim() ?? "", User.Identity?.Name ?? "unknown");
        return new JsonResult(note);
    }
}
