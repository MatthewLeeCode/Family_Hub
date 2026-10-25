# 10. Tags

Every book can carry four sorts of tag. The Library's **Search tags** box
searches whichever of them you switch on.

| Sort | Where it comes from | Who can change it |
|---|---|---|
| Book file tags | The book file's own details | Admins can hide or rename them |
| Community tags | Public book catalogues and shared tag packs | Admins can hide or rename them |
| Family tags | Typed by the family; a few are added automatically for series such as "Star Trek" | Admins and anyone allowed to edit family tags |
| My tags | Typed by you | Only you; nobody else sees them |

## Book file tags are tidied

Book files often carry clutter where the subject should be: ISBNs, dates,
the publisher, adverts for the program that made the file, whole sentences.
Family Hub leaves these out and shows what is left. It also:

- splits combined tags ("Fiction.Horror" becomes "Fiction" and "Horror");
- uses one spelling for common genres ("Thrillers" and "Thriller" are the
  same tag).

Nothing is changed in the files or the library. To see what was left out,
open **Admin → Books → Tidy tags** and look under **Removed as
clutter**.

## Community tags from catalogues

Family Hub asks public catalogues what each book is about and adds the answers
as community tags.

| Catalogue | Needs | Notes |
|---|---|---|
| Open Library | Nothing | The main source. Tested with real books |
| Wikidata | Nothing | Adds genres for well-known books. It limits how often it can be asked, so it fills in slowly |
| Google Books | A free API key | **Not yet tested with a real key** |
| Comic Vine | A free API key | Comics only. **Not yet tested with a real key** |

How it works:

- New books are looked up by themselves, a few each minute. A library of
  300 books takes about an hour and a half the first time.
- A book is looked up by its ISBN if it has one, otherwise by title and
  author.
- A match is only accepted when the title **and** the author agree. A book
  whose title is a file name (`1592005934.pdf`) or whose author is a user
  name (`admin`) will not be recognised unless it has an ISBN. Correct its
  details in the library manager and ask again.
- Comics and game books are rarely in Open Library, Wikidata or Google
  Books. Comics are looked up on Comic Vine instead, once you enter its key
  (see below).
- Only the title, author and ISBN are sent. Nothing about your family or
  what anyone reads leaves the server.

### Looking up by hand

- **One book:** open it and press **Look up tags** under Community tags.
- **Everything waiting:** Admin → Tidy tags → **Look up waiting books now**.
- **After fixing book details:** Admin → Tidy tags → **Ask again about
  unrecognised books**.

A book the catalogues did not know is asked about again after 30 days.

### Switching it off, or adding Google Books

**Admin → Hub → Connections → Community tags from book catalogues.**

- Set **Look up tags for new books** to Off to stop all lookups. Tags
  already found stay.
- To add Comic Vine, see **Comics and Comic Vine** above.
- To add Google Books: in the Google Cloud console create a project, enable
  the **Books API**, create an **API key**, and paste it here. Press **Test
  connection**.

### Comics and Comic Vine

A comic file is named after its series, such as `Star Trek (Gold Key) 07`,
and has no author to match on. Family Hub asks Comic Vine for the series by
name. The publisher or year in brackets settles which series is meant; if
Comic Vine has no series of that name from that publisher, the comic gets no
tags.

Each comic receives the publisher, and the characters and themes that appear
most often in the series. Every issue of one series gets the same tags.

To switch it on: make a free account at `comicvine.gamespot.com`, open
`comicvine.gamespot.com/api` to see your key, and paste it under
**Connections → Community tags from book catalogues → Comic Vine API key**.
Press **Test connection**. Only books of the kind **Graphic novel**, or in a
comic format (CBZ, CBR), are sent to it.

## Hiding and renaming tags

**Admin → Books → Tidy tags** lists every book file tag and community
tag with the number of books carrying it.

- **Hide** removes a tag from every book, the tag search and the stats.
- **Rename** changes it everywhere. Rename two spellings to the same name to
  merge them.
- **Put back**, under **Hidden or renamed by you**, undoes either.

These choices are saved in the daily book-data backup
([guide 6](06-your-data-and-backups.md)).

Family tags and your own tags are not on this page. Remove those on the
book's page with the cross next to the tag.

## Kinds of book

When the catalogues add tags to a book that is still **Unsorted**, Family Hub
tries again to work out its kind ([guide 8](08-adding-and-sorting-books.md)).
A kind that a person chose is never changed.
