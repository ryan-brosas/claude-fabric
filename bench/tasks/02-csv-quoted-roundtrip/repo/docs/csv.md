# CSV field rules

1. Rows are separated by `\n` or `\r\n` outside quotes.
2. Fields are separated by `,` (configurable).
3. A field that starts with `"` is quoted. Inside it, `,,` is a literal comma,
   newlines are kept, and `""` is one literal quote. The field ends at the next
   single `"`.
4. Unquoted fields are trimmed by default (`readCsv`'s `trim: true`).
5. Quoted fields keep their spacing exactly.
6. `stringifyCsv` quotes any field containing the delimiter, a quote, a newline,
   or leading and trailing whitespace, and doubles the quotes inside it.

Promise: `readCsv(stringifyCsv(rows))` returns `rows` for any rows built from
strings, with default options.
