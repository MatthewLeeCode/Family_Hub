# Personal appearance

The household's existing Minimalist design remains the default. Each signed-in profile can now choose its own colour scheme, accent, layout, Scope scene and screen transition from **Profiles → Choose your colours and layout**, or **Your appearance** in the sidebar. No account gets a different look until that person saves one.

There are three layouts:

- **Family** keeps the original spacing, navigation and decorative details.
- **Quiet** uses flat surfaces, a calm left sidebar, simpler headings and fewer decorative details. **Try Quiet dark** previews a dark, teal-accented version with screen transitions off. It introduces no gradients.
- **Compact** puts navigation across the top and gives the library more horizontal room.

All layouts use the same pages, controls, permissions and data. Small screens keep every destination available. Existing Dark, Light, Paper and Blueprint colour schemes work with all three layouts. Paper intentionally remains monochrome.

## Inheritance, preview and saving

Each setting starts on **Use household choice**. Only explicit overrides are stored, so inherited settings follow subsequent household changes. **Design default** for an accent explicitly uses the design's original accent, even if the household uses a custom hue; this differs from inheriting the household accent.

**Preview** applies unsaved choices in the current page. Leaving that page restores saved choices. **Save your appearance** stores the selection for the signed-in profile across devices. **Use all household choices** removes every override. Household defaults remain under the existing admin Appearance section.

If two windows edit the same profile's appearance, a stale save is rejected rather than overwriting the newer selection. Reload the page, then apply the intended change. Resetting to household choices also advances the revision, preventing an older tab from silently undoing the reset.

## Authentication and storage

`GET /api/personal-look` reads the current profile's overrides, effective look, revision and available choices. `POST /api/personal-look` accepts exactly `{"revision": 0, "overrides": {"layout": "quiet"}}`. Revision zero is for a profile with no saved row; subsequent requests use the revision returned by the server.

The authenticated Family Hub session selects the profile. The endpoint never accepts a profile ID, role, arbitrary CSS, font address or stylesheet path. Guests and signed-out visitors cannot read or write preferences. Existing profile permissions still apply to every feature.

Preferences live in the Family Hub SQLite database in `personal_looks`. Deleting a profile cascades to its appearance row. A full SQLite database backup includes this table. The existing daily book-data JSON export covers books, ratings and reading data; it does not export appearance settings. Preserve the database when moving personal looks to another server. Invalid stored values fall back to household defaults.

The optional overrides live in `static/personal-looks.css`, scoped to the root `data-layout` attribute. The Family layout has no layout overrides in that file. New pages should use the common components and semantic labels so they remain functional across every look.
