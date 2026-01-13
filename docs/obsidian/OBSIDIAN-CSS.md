# MUST FOLLOW EXACTLY FOR ABSOLUTE OBSIDIAN NATIVE FEEL

Canvas
This page lists CSS variables used by the Canvas plugin.

CSS variables 
Variable	Description
--canvas-background	Canvas background color
--canvas-card-label-color	Canvas card label text color
--canvas-dot-pattern	Canvas dot pattern color
--canvas-color-1	Canvas card color 1
--canvas-color-2	Canvas card color 2
--canvas-color-3	Canvas card color 3
--canvas-color-4	Canvas card color 4
--canvas-color-5	Canvas card color 5
--canvas-color-6	Canvas card color 6


---

File explorer
This page lists CSS variables used by the File explorer plugin. It currently shares the same variables as Vault profile.

CSS variables 
Variable	Description
--vault-profile-display	display property for the vault profile
--vault-profile-actions-display	display property for the action buttons in the vault profile
--vault-profile-font-size	Font size
--vault-profile-font-weight	Font weight
--vault-profile-color	Text color
--vault-profile-color-hover	Text color (hover)


---

Graph
This page lists CSS variables used by the Graph view plugin.

CSS variables 
Variable	Description
--graph-controls-width	Graph controls width
--graph-text	Node text color
--graph-line	Line color
--graph-node	Resolved node color
--graph-node-unresolved	Unresolved node color
--graph-node-focused	Focused node color
--graph-node-tag	Tag node color
--graph-node-attachment	Attachment node color


---

Search
This page lists CSS variables used by the Search plugin.

CSS variables 
Variable	Description
--search-clear-button-color	Clear search button color
--search-clear-button-size	Clear search button size
--search-icon-color	Search magnifying glass icon color
--search-icon-size	Search icon size
--search-result-background	Search result background color

---

Tag
This page lists CSS variables for tags.

CSS variables 
Variable	Description
--tag-size	Tag font size
--tag-color	Tag text color
--tag-color-hover	Tag text color (hover)
--tag-decoration	Tag text decoration
--tag-decoration-hover	Tag text decoration (hover)
--tag-background	Tag background color
--tag-background-hover	Tag background color (hover)
--tag-border-color	Tag border color
--tag-border-color-hover	Tag border color (hover)
--tag-border-width	Tag border width
--tag-padding-x	Tag left/right padding
--tag-padding-y	Tag top/down padding
--tag-radius	Tag radius
--tag-weight	Tag font weight

---
Table
This page lists CSS variables for tables.

CSS variables 
Variable	Description
--table-background	Table background color
--table-border-width	Table border width
--table-border-color	Table border color
--table-cell-vertical-alignment	Cell vertical alignment
--table-white-space	Table white-space property
--table-header-background	Table header background color
--table-header-background-hover	Table header background color (hover)
--table-header-border-width	Table header border width
--table-header-border-color	Table header border color
--table-header-font	Table header font family
--table-header-size	Table header font size
--table-header-weight	Table header font weight
--table-header-color	Table header text color
--table-line-height	Line height for cell text
--table-text-size	Cell font size
--table-text-color	Cell text color
--table-column-max-width	Column maximum width
--table-column-alt-background	Alternating column background color
--table-column-first-border-width	First column left border width
--table-column-last-border-width	Last column right border width
--table-row-background-hover	Row background color (hover)
--table-row-alt-background	Alternating row background color
--table-row-alt-background-hover	Alternating row background color (hover)
--table-row-last-border-width	Last row bottom border width
--table-selection	Selection background color
--table-selection-blend-mode	Selection blend mode
--table-selection-border-color	Selection border color
--table-selection-border-width	Selection border width
--table-selection-border-radius	Selection border radius
--table-drag-handle-background	Drag handle background color
--table-drag-handle-background-active	Drag handle background color (active)
--table-drag-handle-color	Drag handle icon color
--table-drag-handle-color-active	Drag handle icon color (active)
--table-add-button-background	"Add" button background color
--table-add-button-border-width	"Add" button border width
--table-add-button-border-color	"Add" button border color

---

Properties
This page lists CSS variables for Properties, the YAML metadata editor for frontmatter. See also Checkbox, Text input and Multi-select for variables related to the input types.

CSS variables 
Properties container 
These variables apply to the entire Properties container.

Variable	Description
--metadata-background	Background color
--metadata-display-editing	Display in editing mode
--metadata-display-reading	Display in reading mode
--metadata-max-width	Max width
--metadata-padding	Padding
--metadata-border-color	Border color
--metadata-border-radius	Corner radius
--metadata-border-width	Border width
--metadata-gap	Gap between properties
Individual properties 
These variables apply to individual properties in the list.

Variable	Description
--metadata-divider-color	Color of divider lines between properties
--metadata-divider-color-hover	Color of dividers when property (hover)
--metadata-divider-color-focus	Color of dividers when property (focused)
--metadata-divider-width	Width of divider lines
--metadata-property-padding	Property padding
--metadata-property-radius	Property corner radius
--metadata-property-radius-hover	Property corner radius (hover)
--metadata-property-radius-focus	Property corner radius (focus)
--metadata-property-background	Property background color
--metadata-property-background-hover	Property background color (hover)
--metadata-property-background-active	Property background color (active)
--metadata-label-background-hover	Property label background color (hover)
--metadata-label-background-active	Property label background color (active)
--metadata-label-font-size	Property label font size
--metadata-label-font-weight	Property label font weight
--metadata-sidebar-label-font-size	Property label font size (sidebar)
--metadata-label-text-color	Property label text color
--metadata-label-text-color-hover	Property label text color (hover)
--metadata-label-width	Property label width
--metadata-input-height	Property input height
--metadata-input-text-color	Property input text color
--metadata-input-font-size	Property input font size
--metadata-sidebar-input-font-size	Property input font size (sidebar)
--metadata-input-background	Property input background color
--metadata-input-background-hover	Property input background color (hover)
--metadata-input-background-active	Property input background color (active)


---

List
This page lists CSS variables for ordered and unordered lists.

CSS variables 
Variable	Description
--list-indent	Indentation width for nested items
--list-indent-editing	Indent width in Live Preview
--list-indent-source	Indent width in source mode
--list-spacing	Vertical spacing between list items
--list-marker-color	Marker color
--list-marker-color-hover	Marker color (hover)
--list-marker-color-collapsed	Marker color for collapsed items
--list-bullet-border	Bullet border
--list-bullet-end-padding	Padding after the bullet
--list-bullet-radius	Bullet radius
--list-bullet-size	Bullet width/height
--list-bullet-transform	Bullet transform property
--list-numbered-style	list-style-type for numbered lists

---

Link
This page lists CSS variables for links.

Obsidian supports three different types of links:

Resolved internal links link to an existing note.
Unresolved internal links link to a non-existing note.
External links link to an external URL or URI.
CSS variables 
Variable	Description
--link-color	Resolved link text color
--link-color-hover	Resolved link text color (hover)
--link-decoration	Resolved link text decoration
--link-decoration-hover	Resolved link text decoration (hover)
--link-decoration-thickness	Resolved link text decoration thickness
--link-weight	Link font weight
--link-unresolved-color	Unresolved link text color
--link-unresolved-opacity	Unresolved link opacity
--link-unresolved-filter	Unresolved link filter, e.g. hue-rotate
--link-unresolved-decoration-style	Unresolved link text decoration style
--link-unresolved-decoration-color	Unresolved link text decoration color
--link-external-color	External link text color
--link-external-color-hover	External link text color (hover)
--link-external-decoration	External link text decoration
--link-external-decoration-hover	External link text decoration (hover)

---

Inline title
This page lists CSS variables for inline titles.

Note
To see inline titles, you need to enable Settings → Appearance → Show inline title.

CSS variables 
Variable	Description
--inline-title-color	Inline title text color
--inline-title-font	Inline title font family
--inline-title-line-height	Inline title line height
--inline-title-size	Inline title font size
--inline-title-style	Inline title font style
--inline-title-variant	Inline title font variant
--inline-title-weight	Inline title font weight


---

Headings
This page lists CSS variables for headings.

CSS variables 
Variable	Description
--heading-formatting	Text color for Markdown heading depth syntax
--heading-spacing	Spacing above headings, see Typography
--h1-color	H1 text color
--h2-color	H2 text color
--h3-color	H3 text color
--h4-color	H4 text color
--h5-color	H5 text color
--h6-color	H6 text color
--h1-font	H1 font family
--h2-font	H2 font family
--h3-font	H3 font family
--h4-font	H4 font family
--h5-font	H5 font family
--h6-font	H6 font family
--h1-line-height	H1 line height
--h2-line-height	H2 line height
--h3-line-height	H3 line height
--h4-line-height	H4 line height
--h5-line-height	H5 line height
--h6-line-height	H6 line height
--h1-size	H1 font size
--h2-size	H2 font size
--h3-size	H3 font size
--h4-size	H4 font size
--h5-size	H5 font size
--h6-size	H6 font size
--h1-style	H1 font style
--h2-style	H2 font style
--h3-style	H3 font style
--h4-style	H4 font style
--h5-style	H5 font style
--h6-style	H6 font style
--h1-variant	H1 font variant
--h2-variant	H2 font variant
--h3-variant	H3 font variant
--h4-variant	H4 font variant
--h5-variant	H5 font variant
--h6-variant	H6 font variant
--h1-weight	H1 font weight
--h2-weight	H2 font weight
--h3-weight	H3 font weight
--h4-weight	H4 font weight
--h5-weight	H5 font weight
--h6-weight	H6 font weight


---

File
This page lists CSS variables for open files in the editor.

CSS variables 
Variable	Description
--file-line-width	Width of a line when readable line width is turned on
--file-folding-offset	Width of the line offset for fold indicators
--file-margins	File margins
--file-header-font-size	File header font size
--file-header-font-weight	File header font weight
--file-header-border	File header border-bottom property
--file-header-justify	File header text alignment, uses justify-content


---


Embed
This page lists CSS variables for embedded files.

CSS variables 
Variable	Description
--embed-max-height	Embed max height
--embed-canvas-max-height	Embedded Canvas element max height
--embed-background	Embed background color
--embed-border-end	Embed end border, shorthand property
--embed-border-start	Embed start border, shorthand property
--embed-border-top	Embed top border, shorthand property
--embed-border-bottom	Embed bottom border, shorthand property
--embed-padding	Embedd padding
--embed-font-style	Embed font-style

---

Code
This page lists CSS variables for code.

CSS variables 
Variable	Description
--code-background	Code background color
--code-white-space	Code white-space
--code-size	Code font size
Syntax highlighting 
Note
Since Obsidian uses two different libraries for syntax highlighting—one for Editing view and another for Reading view—styling may not match perfectly between the two.

Variable	Description
--code-normal	Non-highlighted syntax
--code-comment	Comments
--code-function	Functions
--code-important	Important, regex
--code-keyword	Keywords
--code-operator	Operators
--code-property	Properties
--code-punctuation	Punctuation
--code-string	Strings
--code-tag	Tags, symbols, constants
--code-value	Values

---

Callout
This page lists CSS variables for Callouts.

CSS variables 
Variable	Description
--callout-border-width	Callout border width
--callout-border-opacity	Callout border opacity
--callout-padding	Callout padding
--callout-radius	Callout radius
--callout-blend-mode	Callout blend mode, allows color mixing for nested callouts
--callout-title-color	Callout title text color
--callout-title-padding	Callout title padding
--callout-title-size	Callout title font size
--callout-title-weight	Callout title weight
--callout-content-padding	Callout content padding
--callout-content-background	Callout content background color
Type colors 
Callout types have unique icons and colors, and may have multiple aliases.

Variable	Callout type
--callout-bug	bug
--callout-default	default, note
--callout-error	error, danger
--callout-example	example
--callout-fail	fail, failure, missing
--callout-important	important
--callout-info	info
--callout-question	question, help, faq
--callout-success	success, check, done
--callout-summary	summary, abstract, tldr
--callout-tip	tip, hint
--callout-todo	todo
--callout-warning	warning, caution, attention
--callout-quote	quote, cite


---

Blockquote
This page lists CSS variables for blockquotes.

CSS variables 
Variable	Description
--blockquote-background-color	Blockquote background color
--blockquote-border-thickness	Blockquote left border thickness
--blockquote-border-color	Blockquote left border color
--blockquote-font-style	Blockquote font style (e.g. normal, italic)
--blockquote-color	Blockquote text color

---

Block
This page lists CSS variables for rendered blocks in Live Preview.

CSS variables 
Variable	Description
--embed-block-shadow-hover	Hover shadow for rendered embed blocks in Live Preview

---

Bases
This page lists CSS variables for Bases. See also Properties, Checkbox, Text input and Multi-select for variables related to properties and input types.

CSS variables 
Base container 
These variables apply to the entire Properties container.

Variable	Description
--bases-header-border-width	Width of border around the header area
--bases-header-height	Height of the base header area that contains the toolbar
--bases-header-padding-start	Start padding (left in LTR mode)
--bases-header-padding-end	End padding (right in LTR mode)
--bases-toolbar-label-display	Display of toolbar button labels
--bases-toolbar-badge-display	Display of toolbar number badges
--bases-embed-border-width	Border width around base view when embedded
--bases-embed-border-color	Border color around base view when embedded
--bases-embed-border-radius	Radius around base view when embedded
--bases-filter-menu-width	Width of the filter menu
Table view 
Variable
--bases-table-container-border-width
--bases-table-container-border-radius
--bases-table-header-weight
--bases-table-header-color
--bases-table-header-icon-display
--bases-table-header-background
--bases-table-header-background-hover
--bases-table-header-sort-mask
--bases-table-border-color
--bases-table-column-border-width
--bases-table-row-border-width
--bases-table-row-background-hover
--bases-table-row-height
--bases-table-text-size
--bases-table-column-max-width
--bases-table-column-min-width
--bases-table-cell-radius-active
--bases-table-cell-shadow-active
--bases-table-cell-background-active
--bases-table-cell-background-disabled
Cards view 
Variable
--bases-cards-container-background
--bases-cards-background
--bases-cards-cover-background
--bases-cards-scale
--bases-cards-group-padding
--bases-cards-line-height
--bases-cards-border-width
--bases-cards-shadow
--bases-cards-shadow-hover


---

## CSS Variables Hierarchy

**CSS variables**
- **Components** (DO NOT TOUCH)
  - Button 
  - Checkbox
  - Color input
  - Dialog
  - Dragging
  - Dropdowns
  - Indentation guides
  - Modal
  - Multi-select
  - Navigation
  - Popover
  - Prompt
  - Slider
  - Tabs
  - Text input
  - Toggle
- **Editor** (BE CREATIVE HERE)
  - Bases
  - Block
  - Blockquote
  - Callout
  - Code
  - Embed
  - File
  - Footnote
  - Headings
  - Horizontal rule
  - Inline title
  - Link
  - List
  - Properties
  - Table
  - Tag
- **Foundations** (DO NOT TOUCH)
  - Borders 
  - Colors
  - Cursor
  - Icons
  - Layers
  - Radiuses
  - Spacing
  - Typography
- **Plugins** (BE CREATIVE HERE)
  - Canvas
  - File explorer
  - Graph
  - Search
  - Sync
- **Publish** (DO NOT TOUCH)
- **Window** (DO NOT TOUCH)
  - Divider
  - Ribbon
  - Scrollbar
  - Sidebar (EXCEPTION - ONLY IF APPLICABLE)
  - Status bar
  - Vault profile (EXCEPTION - ONLY IF RELEVANT)
  - Window frame
  - Workspace
- About styling
