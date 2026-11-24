import json
import pickle
import struct
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "scripts"))
from agy_screen import PLACEHOLDER, SHORTCUTS, Screen, cell_width


LABEL = "auto · Gemini 4 Neon · high"


def composer_screen(body="", model=False, draft=""):
    screen = Screen(struct.pack("HHHH", 6, 100, 0, 0))
    screen.paste = True
    screen.visible = True
    screen.y, screen.x = 1, 2 + cell_width(draft)
    for y in (0, 2):
        screen.lines[y] = dict.fromkeys(range(screen.cols), ("─", "90"))
    row = screen.lines[1]
    row[0] = (">", "94")
    for i, char in enumerate(body, 2):
        row[i] = (char, "90" if body == PLACEHOLDER else "")
    footer = screen.lines[3]
    if not draft:
        footer.update({i: (c, "90") for i, c in enumerate(SHORTCUTS)})
    if model:
        start = screen.cols - len(LABEL)
        footer.update({start + i: (c, "33" if i < 4 else "39;2")
                       for i, c in enumerate(LABEL)})
    return screen


class ScreenReasonsTest(unittest.TestCase):
    def check(self, screen, expected, draft=""):
        before = pickle.dumps(screen)
        self.assertEqual(screen.composer_reason(draft), expected)
        self.assertEqual(screen.composer(draft), expected is None)
        self.assertEqual(pickle.dumps(screen), before)

    def test_parser_and_visibility(self):
        cases = [
            ("valid", False, "invalid_parser", True, False),
            ("reset_required", True, "reset_required", False, False),
            ("escape", "\x1b[", "escape_pending", False, False),
            ("string", "]", "string_pending", False, False),
            ("sync", True, "sync", False, False),
            ("normal", (), "alternate_screen", True, False),
            ("paste", False, "paste_disabled", True, False),
            ("needs_clear", True, "repaint", False, True),
            ("visible", False, "invisible", False, True),
        ]
        for field, value, reason, blocked, readable in cases:
            with self.subTest(reason=reason):
                screen = composer_screen()
                setattr(screen, field, value)
                self.check(screen, reason)
                self.assertEqual(screen.blocked(), blocked)
                self.assertEqual(bool(screen.text()), readable)
        screen = composer_screen()
        screen.feed(b"\xe4")
        self.check(screen, "utf8_pending")
        self.assertFalse(screen.blocked())
        self.assertEqual(screen.text(), [])

    def test_modal_border_marker_and_cursor(self):
        for y, col, cell, reason in [
            (0, 0, ("x", "90"), "border_text"),
            (2, 8, ("─", ""), "border_ink"),
            (1, 0, ("x", "94"), "marker_text"),
            (1, 0, (">", ""), "marker_ink"),
            (1, 1, (" ", "90"), "trailing_cells"),
        ]:
            with self.subTest(reason=reason):
                screen = composer_screen()
                screen.lines[y][col] = cell
                self.check(screen, reason)
        screen = composer_screen()
        screen.lines[1][1] = (" ", "")
        self.check(screen, None)
        screen.x += 1
        self.check(screen, "cursor")
        screen.y = 0
        self.check(screen, "border_position")
        screen.lines[4] = {i: (c, "") for i, c in enumerate("Esc to cancel")}
        self.check(screen, "blocked_modal")
        self.assertTrue(screen.blocked())

    def test_body(self):
        self.check(composer_screen("private"), "placeholder_text")
        self.check(composer_screen("private"), "draft_text", "expected")
        self.check(composer_screen("private", draft="private"), None, "private")
        screen = composer_screen(PLACEHOLDER, model=True)
        self.check(screen, None)
        del screen.lines[1][2 + PLACEHOLDER.index(" ")]
        self.check(screen, "placeholder_ink")

    def test_footer(self):
        screen = composer_screen(PLACEHOLDER)
        self.check(screen, "footer_model_missing")
        screen = composer_screen(model=True)
        self.check(screen, None)
        start = screen.cols - len(LABEL)
        footer = screen.lines[3]
        footer[start + 1] = ("u", "")
        self.check(screen, "footer_model_ink")
        footer[start + 1] = ("u", "33")
        for col in range(start, screen.cols):
            footer[col - 1] = footer.pop(col)
        self.check(screen, "footer_alignment")
        footer[start - 1] = ("X", "33")
        self.check(screen, "footer_model_text")
        footer[0] = ("?", "94")
        self.check(screen, "footer_ink")
        del footer[0]
        self.check(screen, "footer_text")
        screen.lines[4][0] = ("x", "")
        self.check(screen, "footer_position")

    def test_native_replay(self):
        data = json.loads((HERE / "fixtures" / "agy-1.5.14.json").read_bytes())
        screen = Screen(struct.pack("HHHH", data["rows"], data["cols"], 0, 0))
        for state in data["replay_order"]:
            screen.feed(data["frames"][state].encode())
            with self.subTest(state=state):
                self.assertEqual(screen.composer_reason("") is None,
                                 state in ("baseline", "clear"))
                self.assertEqual(screen.composer_reason("XATS_DRAFT_FIXTURE") is None,
                                 state == "draft")

    def test_scrollback_erase_preserves_visible_composer_and_cannot_recover_it(self):
        screen = composer_screen(model=True)
        before = screen.text()
        screen.feed(b"\x1b[3J")
        self.assertEqual(screen.text(), before)
        self.check(screen, None)
        screen.feed(b"\x1b[>4;2m\x1b[=5;1u\x1b[?u\x1b[0 q")
        self.assertEqual(screen.text(), before)
        self.check(screen, None)
        screen.needs_clear = True
        screen.feed(b"\x1b[3J")
        self.check(screen, "repaint")

    def test_first_reset_control_survives_bank_switch_and_resize_until_ris(self):
        screen = composer_screen(model=True)
        screen.feed(b"\x1b[?1049h\x1b[?9999h\x1b[1;30r\x1b[?1049l")
        screen.resize(struct.pack("HHHH", 51, 203, 0, 0))
        screen.feed(b"\x1b[3J\x1b[H\x1b[2J")
        self.check(screen, "reset_required_alt_decset_9999")
        screen.feed(b"\x1bc")
        self.check(screen, "paste_disabled")
        self.assertIsNone(screen.reset_origin)
        screen.feed(b"\x1b[1;51r")
        self.check(screen, "reset_required_main_margins_1_51")

    def test_default_neon_style_and_position(self):
        screen = composer_screen()
        label = "Gemini 4 Neon · high"
        start = screen.cols - len(label)
        footer = screen.lines[3]
        for i, char in enumerate(label, start):
            footer[i] = (char, "39;2")
        self.check(screen, None)
        footer[start] = ("G", "33")
        self.check(screen, "footer_model_ink")
        screen.lines[1][2] = ("x", "")
        self.check(screen, "placeholder_text")

    def test_only_a_new_sync_frame_counts_and_cells_wait_for_close(self):
        screen = composer_screen()
        screen.feed(b"\x1b[?2026h")
        saved_at_input = screen.redraws
        screen.feed(b"\x1b[?25h\x1b[?2026h")
        self.check(screen, "sync")
        screen.feed(b"\x1b[?2026l")
        self.assertEqual(screen.redraws, saved_at_input)
        self.check(screen, None)
        screen.feed(b"\x1b[?2026h\x1b[?2026l")
        self.assertGreater(screen.redraws, saved_at_input)

    def test_restored_flash_effort_label(self):
        for prefix in ("", "auto · "):
            for effort in ("high", "xhigh", "max"):
                screen = composer_screen()
                label = f"{prefix}Gemini 3.8 Flash · {effort}"
                start = screen.cols - len(label)
                for i, char in enumerate(label):
                    screen.lines[3][start + i] = (char, "33" if prefix and i < 4 else "39;2")
                self.check(screen, None)
                screen.lines[3][screen.cols - 1] = ("!", "39;2")
                self.check(screen, "footer_model_text")

    def test_grapheme_cluster_mode_2027_does_not_require_reset(self):
        screen = composer_screen(model=True)
        screen.feed(b"\x1b[?1049h\x1b[?2027h\x1b[?1049l")
        self.check(screen, None)
        self.assertIsNone(screen.reset_origin)
        screen.feed(b"\x1b[?2027l")
        self.check(screen, None)
        self.assertIsNone(screen.reset_origin)


if __name__ == "__main__":
    unittest.main()
