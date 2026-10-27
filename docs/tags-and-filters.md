# Tags and filters

[← Back to the README](../README.md)

<a href="images/tags.png"><img src="images/tags.png" alt="The Tags page" width="760"></a>

With hundreds or thousands of domains, a flat list is hard to work with. **Tags** are short labels on domains (`emea`, `prod`, `team-payments`, `acquired-2024`) that you can filter every page by. A domain can have several.

**Putting tags on domains.** When you are signed in, every row on the **Domains** page has a **+ tag** button for tagging that domain on the spot. For many domains at once there is the **Tags** page in the sidebar (it always asks for the login):
- Search the domain list, tick rows (or **Select all N matching**) and **Add tag** / **Remove tag**. Searching also finds tags, so `emea` lists the domains that have it.
- **Import** a list (`example.com, emea, prod`, one domain per line). **Check** shows what would happen and which lines are wrong before anything changes; you can add to a domain's tags or replace them. **Export tags (CSV)** gives you the same format back.
- **Automatic rules** give a tag to every domain whose **name** matches, including domains that appear later: for example, tag `emea` for domains that end in `.de` or `.fr`. Rules use the same condition builder as the filter, and **Preview** lists the domains a rule matches before you save it. Nothing is stored per domain, so changing a rule changes every domain at once. A tag from a rule shows a small gear and can't be removed from a single domain.
- Tags can be renamed (naming one the same as another merges them) and deleted.
- **Colours.** Every new tag is given a colour at once, chosen to differ from the colours already in use (the first ten tags all look different). Click the coloured dot on a tag in the Tags list to pick another of ten colours, or *Pick one for me*. The colour shows wherever the tag does: the Domains page, the Tags page and the tag editor, on both the dark and light themes. A colour moves with a tag when it is renamed and is forgotten when the tag is deleted.

**Filtering: the Filter button** (next to the domain selector, on every page). Build a filter from conditions, in groups:

<a href="images/filter-builder.png"><img src="images/filter-builder.png" alt="The filter builder: has tag emea and policy is one of none, quarantine" width="760"></a>


| Field | Conditions |
|---|---|
| **Tag** | has tag, doesn't have tag, has any of / all of / none of, has any tag, has no tags |
| **Domain** | equals, doesn't equal, contains, doesn't contain, starts with, ends with, is one of, is not one of |
| **Policy** | is, is not, is one of, is not one of (`none`, `quarantine`, `reject`, or `unknown` for a domain with no report yet) |

Each group is **all of (AND)** or **any of (OR)** its items, and can be inverted with **Not**; groups nest up to three levels. For example, *has tag `emea` AND (domain ends with `.de` OR policy is not `reject`)*. The filter applies to every page, the exports, the summary report and the map; it is kept in the URL, so a filtered view can be bookmarked or shared, and it combines (AND) with the domain selector and the time range. A tag chip on the Domains page filters to that tag in one click, and a link such as `/domains?tag=emea` works too (several tags with commas mean *any of them*).

**Good to know.** Tags are for organising and filtering, not for access control: anyone who can see the dashboard sees all the tags, and a filter in a URL is not a security boundary. Limits: 20 tags set by hand per domain, 200 tags, 50 rules, 30 conditions per filter. Filtering by policy looks at each domain's latest published policy.
