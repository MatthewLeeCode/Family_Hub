# Tag packs

A tag pack is a JSON file listing books and the tags readers have given them.
Family Hub loads every `*.json` file in this folder and shows the tags as
**Community tags**. This is how trope tags get shared between households:
add a pack, open a pull request, and everyone who updates gets your tags.

```json
{
  "name": "Cosy fantasy",
  "description": "Optional, one line.",
  "books": [
    {"title": "Book title", "author": "Author Name", "isbn": "9780000000000", "tags": ["Found family", "Slow burn"]}
  ]
}
```

- `title` and `author` are required; `isbn` is optional but makes matching exact.
- Books that are in your library receive the tags.
- Books that are not in your library appear as suggestions under "Similar books".
- Keep tags short and reusable ("Slow burn", not "the slowest burn ever").
- Packs contain tags only. Do not include book text, covers or download links.

To build a pack from your own family's tags, use **Dashboard → Admin →
Download book data** and copy the entries you want to share. Leave out
ratings, reading history and personal tags; those are private.
