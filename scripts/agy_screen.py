from __future__ import annotations

import codecs
import re
import struct
import unicodedata


PLACEHOLDER = "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)"
SHORTCUTS = "? for shortcuts"
MODEL = re.compile(r"(?:auto · (?:Claude (?:Opus|Sonnet|Haiku) [0-9.]+(?: \(Thinking\))?"
                   r"|Gemini [0-9.]+ (?:Pro|Flash)(?: \((?:Low|Medium|High)\))?)"
                   r"|(?:auto · )?Gemini [0-9]+(?:\.[0-9]+)* (?:Pro|Flash|Neon)"
                   r" · (?:low|medium|high|xhigh|max))")


def cell_width(text):
    return sum(1 + (unicodedata.east_asian_width(c) in ("W", "F")) for c in text)


class Screen:
    """Track only the VT operations used by the supported inline composer."""

    def __init__(self, size):
        self.rows, self.cols = struct.unpack("HHHH", size)[:2]
        self.valid = 0 < self.rows <= 256 and 0 < self.cols <= 512
        self.lines = [dict() for _ in range(self.rows if self.valid else 0)]
        self.y = self.x = 0
        self.tabs = set(range(8, self.cols, 8))
        self.escape = self.string = self.payload = self.recovery = ""
        self.string_esc = self.reset_required = False
        self.reset_origin = None
        self.paste = self.sync = False
        self.wrap = self.visible = True
        self.normal = None
        self.redraws = 0
        self.ink = ""
        self.last_graphic = None
        self.needs_clear = False
        self.position_known = True
        self.decoder = codecs.getincrementaldecoder("utf-8")("surrogateescape")

    def down(self):
        if self.y == self.rows - 1:
            self.lines.pop(0)
            self.lines.append({})
        else:
            self.y += 1

    def erase(self, start, end):
        row = self.lines[self.y]
        for col in range(start, end):
            if row.get(col, (" ",))[0] == "":
                row.pop(col - 1, None)
            if row.get(col + 1, (" ",))[0] == "":
                row.pop(col + 1, None)
            row.pop(col, None)

    def glyph(self, char):
        self.last_graphic = None
        if char == "\r":
            self.x = 0
        elif char == "\n":
            self.down()
        elif char == "\t":
            self.x = min((col for col in self.tabs if col > self.x),
                         default=self.cols - 1)
        elif char == "\b":
            self.x = max(0, min(self.cols - 1, self.x) - 1)
        elif char == "\a":
            return
        elif unicodedata.combining(char):
            row = self.lines[self.y]
            pos = self.x - 1
            if row.get(pos, (" ",))[0] == "":
                pos -= 1
            if pos < 0:
                self.valid = False
            else:
                base, ink = row.get(pos, (" ", self.ink))
                row[pos] = base + char, ink
        elif unicodedata.category(char)[0] in ("C", "M"):
            self.valid = False
        else:
            width = 1 + (unicodedata.east_asian_width(char) in ("W", "F"))
            if self.x + width > self.cols:
                if not self.wrap:
                    self.valid = False
                    return
                self.down()
                self.x = 0
            self.erase(self.x, self.x + width)
            self.lines[self.y][self.x] = char, self.ink
            if width == 2:
                self.lines[self.y][self.x + 1] = "", self.ink
            self.x += width
            if width == 1:
                self.last_graphic = char

    def csi(self, seq, preceding):
        op = seq[-1]
        params = seq[2:-1]
        if seq[2:] == "?5W":
            self.tabs = set(range(8, self.cols, 8))
            return
        if seq[2:] in (">q", "c", "?2026$p", "?2027$p", ">4m", ">4;2m",
                       ">5u", "=5;1u", "<1u", "?u", "0 q", "x"):
            return
        if params.startswith("?") and op in "hl":
            self.modes(params[1:].split(";"), op == "h")
            return
        if not re.fullmatch(r"[0-9;]*", params):
            self.valid = False
            return
        args = [int(v or 0) for v in params.split(";")]
        arg = args[0]
        n = arg or 1
        col = min(self.x, self.cols - 1)
        if op == "m":
            if params == "2" and self.ink in ("", "0", "39", "39;2"):
                self.ink = "39;2"
            else:
                self.ink = params
            return
        if op in "Hf" and len(args) <= 2:
            self.position_known = True
            self.y = min(n, self.rows) - 1
            self.x = min(max(args[-1] if len(args) == 2 else 1, 1), self.cols) - 1
        elif len(args) != 1:
            self.valid = False
        elif op in "AB":
            self.y = max(0, min(self.rows - 1, self.y + (n if op == "B" else -n)))
            self.x = col
        elif op in "G`":
            self.x = min(n, self.cols) - 1
        elif op in "CD":
            self.x = min(self.cols - 1, col + n) if op == "C" else max(0, col - n)
        elif op == "Z":
            stops = sorted((tab for tab in self.tabs if tab < col), reverse=True)
            self.x = stops[n - 1] if n <= len(stops) else 0
        elif op == "b":
            if preceding is None or n > self.rows * self.cols:
                self.valid = False
                return
            for _ in range(n):
                self.glyph(preceding)
                if not self.valid:
                    break
            self.last_graphic = None
        else:
            self.edit_line(op, arg, n, col)

    def edit_line(self, op, arg, n, col):
        if op == "g" and arg in (0, 3):
            if arg == 3:
                self.tabs.clear()
            else:
                self.tabs.discard(col)
        elif op == "K" and arg <= 2:
            self.erase(col if arg == 0 else 0, col + 1 if arg == 1 else self.cols)
        elif op == "P":
            count = min(n, self.cols - col)
            row = self.lines[self.y]
            self.erase(col, col + count)
            self.lines[self.y] = {(i if i < col else i - count): cell
                                  for i, cell in row.items()}
        elif op == "X":
            self.erase(col, min(col + n, self.cols))
        elif op == "J" and arg == 3:
            # ED 3 erases saved scrollback, outside the visible cell grid.
            return
        elif op == "J" and arg in (0, 2):
            if self.position_known and (arg == 2 or (self.x, self.y) == (0, 0)):
                self.needs_clear = False
            start = self.y if arg == 0 else 0
            self.erase(col if arg == 0 else 0, self.cols)
            for row in self.lines[start + (arg == 0):]:
                row.clear()
        else:
            self.valid = False

    def modes(self, modes, enabled):
        for mode in modes:
            if mode == "2004":
                self.paste = enabled
            elif mode == "2026":
                # Count the start so a frame already open at input time cannot
                # acknowledge that input. Its cells stay unreadable until close.
                self.redraws += int(enabled and not self.sync)
                self.sync = enabled
            elif mode == "2027":
                # Unicode grapheme cluster mode (DECSET/DECRST 2027). Fixed
                # ASCII/CJK composer verification is unaffected.
                continue
            elif mode == "7":
                self.wrap = enabled
            elif mode == "25":
                self.visible = enabled
                self.redraws += int(enabled and not self.sync)
            elif mode == "1049":
                self.alternate(enabled)
            else:
                self.require_reset("decset" if enabled else "decrst", mode)

    def require_reset(self, command, parameter):
        if not self.reset_required:
            # Report only bounded numeric controls, never terminal payloads.
            code = "default" if not parameter else "other"
            if re.fullmatch(r"[0-9]{1,5}(;[0-9]{1,5})?", parameter):
                code = parameter.replace(";", "_")
            bank = "main" if self.normal is None else "alt"
            self.reset_origin = f"reset_required_{bank}_{command}_{code}"
        self.valid = False
        self.reset_required = True

    def alternate(self, enabled):
        if enabled and self.normal is None:
            self.normal = self.lines, self.y, self.x, self.needs_clear, self.valid
            self.lines = [dict() for _ in range(self.rows)]
            self.y = self.x = 0
        elif not enabled and self.normal is not None:
            self.lines, self.y, self.x, self.needs_clear, self.valid = self.normal
            self.normal = None

    def string_char(self, char):
        if (self.string_esc and char == "\\") or (self.string == "]" and char == "\a"):
            if self.string == "]" and not (self.payload in ("11;?", "7501;?")
                                           or self.payload.startswith(("0;", "2;"))):
                self.valid = False
            self.string = self.payload = ""
        elif char != "\x1b" and len(self.payload) < 128:
            self.payload += char
        self.string_esc = char == "\x1b"

    def dispatch(self, seq):
        preceding, self.last_graphic = self.last_graphic, None
        if seq == "\x1bc":
            count = self.redraws
            self.__init__(struct.pack("HHHH", self.rows, self.cols, 0, 0))
            self.redraws = count
            return
        if not self.valid:
            marker = {"\x1b[H": "home", "\x1b[1;1H": "home",
                      "\x1b[2J": "clear"}.get(seq, "")
            if (not self.reset_required and marker and self.recovery
                    and marker != self.recovery):
                self.lines = [dict() for _ in range(self.rows)]
                self.y = self.x = 0
                self.valid = self.position_known = True
                self.needs_clear = False
            self.recovery = marker
        if seq.startswith("\x1b["):
            self.csi(seq, preceding)
            if not self.valid and seq[-1] in "hlr" and not seq.startswith("\x1b[?"):
                command = {"h": "set", "l": "unset", "r": "margins"}[seq[-1]]
                self.require_reset(command, seq[2:-1])
        elif seq == "\x1bH":
            self.tabs.add(min(self.x, self.cols - 1))
        elif seq == "\x1bM":
            if self.y:
                self.y -= 1
            else:
                self.lines.insert(0, {})
                self.lines.pop()
        else:
            self.valid = False

    def feed(self, data):
        if not self.lines:
            return
        for char in self.decoder.decode(data):
            if self.string:
                self.string_char(char)
            elif char == "\x1b":
                if self.escape:
                    self.last_graphic = None
                self.escape = char
            elif self.escape:
                self.escape += char
                if len(self.escape) == 2 and char in "]P_^X":
                    self.last_graphic = None
                    self.string = char
                    self.string_esc = False
                    if char != "]":
                        self.valid = False
                    self.recovery = self.escape = ""
                elif len(self.escape) > 128:
                    self.last_graphic = None
                    self.valid = False
                    self.escape = ""
                elif self.escape != "\x1b[" and "@" <= char <= "~":
                    self.dispatch(self.escape)
                    self.escape = ""
            else:
                self.recovery = ""
                if self.valid:
                    self.glyph(char)

    def _text_reason(self):
        if self.reset_required and self.reset_origin:
            return self.reset_origin
        if not self.valid or not self.lines:
            return "invalid_parser"
        if self.reset_required:
            return "reset_required"
        if self.escape:
            return "escape_pending"
        if self.string:
            return "string_pending"
        if self.decoder.getstate()[0]:
            return "utf8_pending"
        if self.sync:
            return "sync"
        if self.normal is not None:
            return "alternate_screen"
        if not self.paste:
            return "paste_disabled"
        return None

    def _rendered_lines(self):
        return ["".join(row.get(i, (" ",))[0] for i in range(max(row, default=-1) + 1))
                .rstrip() for row in self.lines]

    def text(self):
        return [] if self._text_reason() else self._rendered_lines()

    def resize(self, size):
        rows, cols = struct.unpack("HHHH", size)[:2]
        if (rows, cols) != (self.rows, self.cols):
            paste, visible, wrap = self.paste, self.visible, self.wrap
            alternate = self.normal is not None
            synchronized, count = self.sync, self.redraws
            reset_required, origin = self.reset_required, self.reset_origin
            self.__init__(size)
            self.paste, self.visible, self.wrap = paste, visible, wrap
            self.sync, self.redraws = synchronized, count
            self.reset_required, self.reset_origin = reset_required, origin
            self.needs_clear = True
            self.position_known = False
            if alternate:
                self.alternate(True)

    def blocked(self):
        if not self.valid or self.normal is not None or not self.paste:
            return True
        return self._has_active_prompt(self.text())

    def _has_active_prompt(self, lines):
        active_prompts = ("requesting permission for:", "run this command?",
                          "no, cancel", "esc to cancel", "esc to interrupt")
        start = 0
        if (0 < self.y < len(lines) and lines[self.y - 1] == "─" * self.cols
                and self.lines[self.y].get(0) == (">", "94")):
            start = self.y - 1
            while start > max(0, self.y - 3) and lines[start - 1].strip():
                start -= 1
        return any(line.strip().lower().startswith(active_prompts)
                   for line in lines[start:])

    def composer(self, draft):
        return self.composer_reason(draft) is None

    def composer_reason(self, draft: str) -> str | None:
        reason = self._text_reason()
        if reason:
            return reason
        if self.needs_clear:
            return "repaint"
        if not self.visible:
            return "invisible"
        lines = self._rendered_lines()
        if self._has_active_prompt(lines):
            return "blocked_modal"
        edit = self.y
        if edit < 1 or edit + 1 >= self.rows:
            return "border_position"
        border = "─" * self.cols
        if lines[edit - 1] != border or lines[edit + 1] != border:
            return "border_text"
        row = self.lines[edit]
        marker, ink = row.get(0, ("", ""))
        if marker != ">":
            return "marker_text"
        if ink != "94":
            return "marker_ink"
        if any(ink != "90" for i in (edit - 1, edit + 1)
               for _, ink in self.lines[i].values()):
            return "border_ink"
        body = lines[edit][2:]
        if body and not draft:
            if body != PLACEHOLDER:
                return "placeholder_text"
            if any(row.get(i, ("", ""))[1] != "90" for i in range(2, 2 + len(body))):
                return "placeholder_ink"
        elif lines[edit] != ("> " + draft).rstrip():
            return "draft_text"
        # A cleared composer can retain the prompt's single separator cell.
        extent = cell_width(lines[edit])
        if lines[edit] == ">" and row.get(1) == (" ", ""):
            extent = 2
        if max(row) >= extent:
            return "trailing_cells"
        if self.x != cell_width(draft) + 2:
            return "cursor"
        return self._footer_reason(lines[edit + 2:], body, draft)

    def _footer_reason(self, footer, body, draft):
        if any(footer[1:]):
            return "footer_position"
        status = next(iter(footer), "")
        if not draft:
            if not footer:
                return "footer_position"
            if not status.startswith(SHORTCUTS):
                return "footer_text"
            cells = self.lines[self.y + 2]
            if any(cells.get(i) != (c, "90") for i, c in enumerate(SHORTCUTS)):
                return "footer_ink"
            status = status[len(SHORTCUTS):]
        if not status:
            return "footer_model_missing" if body and not draft else None
        label = status.lstrip(" ")
        if not status.startswith("  "):
            return "footer_alignment"
        auto = label.startswith("auto · ")
        if not MODEL.fullmatch(label) or (body == PLACEHOLDER and not auto):
            return "footer_model_text"
        cells = self.lines[self.y + 2]
        start = self.cols - len(label)
        for i, char in enumerate(label):
            glyph, ink = cells.get(start + i, ("", ""))
            if glyph != char:
                return "footer_alignment"
            if ink != ("33" if auto and i < 4 else "39;2"):
                return "footer_model_ink"
        return None
