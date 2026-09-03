# Resume format guide

You generate PANDOC MARKDOWN. It is rendered by

    pandoc resume.md --standalone --pdf-engine=weasyprint --css=cv.css -o resume.pdf

cv.css does all the layout. Your only job is to emit the blocks it styles.

## Hard rules

1. NO HTML. Not a single tag. No `<div>`, no `<section>`, no `<a href>`, no
   `<br>`. The renderer is not a browser and raw HTML is rejected by the
   DataValidator.
2. Every `::: {.class}` opens a block and MUST be closed by a bare `:::` on its
   own line. An unclosed fence does NOT raise an error: pandoc renders the text
   with no styling at all, so the CV comes out looking broken and nobody is
   told. Count your fences.
3. The source CV you are given is ALREADY in this format. EDIT it. Copy the
   blocks you keep character for character. Do not retype them and do not
   "improve" the markup.
4. Use only the classes below. cv.css styles nothing else, so an invented class
   name renders as plain text.

## The document

### Name

    [Full Name]{.cv-name}

A span, not a heading. It renders centred, bold, uppercase.

### Contacts

    ::: {.contacts}
    [me@example.com](mailto:me@example.com) [•]{.sep} [linkedin.com/in/user](https://linkedin.com/in/user)  \
    +351-000-000-000  \
    City, Country [•]{.sep} Remote only
    :::

One paragraph, with a BACKSLASH at the end of every line except the last. That
backslash is the line break. Drop it and the lines weld into one run of text,
which a PDF text extractor then reads as a single word.

`[•]{.sep}` is the separator between items ON a line. It is a span, so it never
ends a line.

Link text is the visible text; the URL goes in the parentheses. Keep the scheme
in the URL, not in the text.

### Summary

    ::: {.summary}
    First paragraph.

    Second paragraph.
    :::

One or more paragraphs, justified. Blank line between them.

### Section headings

    ## Whatever the source calls this section

Level 2, `##`. It renders uppercase with a rule under it, so do not uppercase it
yourself. Nothing else produces a section heading.

THE TEXT OF EVERY HEADING COMES FROM THE SOURCE CV, word for word. There is no
house style and no required section name here. If the source says
"## Selected Professional Experience", write exactly that, not "PROFESSIONAL
EXPERIENCE" and not "PROFESSIONAL EXPERIENCE (Last 8 Contracts)".

### Skills

    ::: {.skills}
    **Backend:** Node.js, TypeScript, GraphQL

    **Data:** PostgreSQL, ClickHouse
    :::

One paragraph per labelled line, blank line between them. The label is bold and
ends with a colon INSIDE the bold marks.

### Experience entries

    ::: {.entry}
    ### **Company Name** - *Job Title*

    **Mon YYYY - Mon YYYY**

    * First bullet.
    * Second bullet.
    :::

One `::: {.entry}` per job. Inside it, in this order:

- an `###` heading holding `**Company**` then ` - ` then `*Title*`
- a paragraph holding only the bold date range, which floats to the right
- a bullet list with `*`

The date paragraph must follow the heading immediately, with one blank line
between. The CSS floats the heading left and the date right onto the same line,
so any other order breaks the layout.

Use a plain hyphen in the date range, never an en-dash or an em-dash.

## Content

- Show concrete results: impact, not tasks. Keep the numbers that are in the
  source.
- Name the technologies inside the achievement, not as a separate list.
- Feature keywords that match the job posting ONLY if they already exist in the
  source CV. Never add a technology the candidate has not used.
- One to two pages. Two full pages is normal for a long career. Do not shrink
  margins, line height or font size to force one page: the stylesheet decides
  those and you cannot override it.
- If it does not fit, cut the least relevant content. Do not abbreviate job
  titles or section names.
- Keep the original writing voice.
