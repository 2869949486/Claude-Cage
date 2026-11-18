"""Temporary fixtures only; never inspect the actual user's home."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("host_tools_config", Path(__file__).with_name("host_tools_config.py"))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)

ENTRY = {"type": "http", "url": "http://127.0.0.1:18962/", "headers": {"Authorization": "Bearer t"}}


class HostToolsConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)

    def test_every_profile_is_found(self):
        account = self.home / ".local/share/cage/claude-accounts/work/config"
        account.mkdir(parents=True)
        self.assertEqual(config.profile_files(self.home), [self.home / ".claude.json", account / ".claude.json"])

    def test_entry_is_added_beside_existing_settings(self):
        path = self.home / ".claude.json"
        path.write_text(json.dumps({"theme": "dark", "mcpServers": {"other": {"command": "x"}}}))
        path.chmod(0o640)
        self.assertTrue(config.add_server(path, "computer", ENTRY))
        data = json.loads(path.read_text())
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(data["mcpServers"], {"other": {"command": "x"}, "computer": ENTRY})
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_missing_file_is_created_private(self):
        path = self.home / ".claude.json"
        self.assertTrue(config.add_server(path, "computer", ENTRY))
        self.assertEqual(json.loads(path.read_text()), {"mcpServers": {"computer": ENTRY}})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_unchanged_entry_is_not_rewritten(self):
        path = self.home / ".claude.json"
        config.add_server(path, "computer", ENTRY)
        before = path.stat().st_ino
        self.assertFalse(config.add_server(path, "computer", ENTRY))
        self.assertEqual(path.stat().st_ino, before)

    def test_new_token_replaces_the_old_entry(self):
        path = self.home / ".claude.json"
        config.add_server(path, "computer", ENTRY)
        newer = dict(ENTRY, headers={"Authorization": "Bearer u"})
        self.assertTrue(config.add_server(path, "computer", newer))
        self.assertEqual(json.loads(path.read_text())["mcpServers"]["computer"], newer)

    def test_the_users_own_server_of_that_name_is_kept(self):
        path = self.home / ".claude.json"
        own = {"type": "http", "url": "https://example.com/mcp"}
        path.write_text(json.dumps({"mcpServers": {"computer": own}}))
        self.assertFalse(config.add_server(path, "computer", ENTRY))
        self.assertEqual(json.loads(path.read_text())["mcpServers"]["computer"], own)

    def test_unreadable_file_is_left_alone(self):
        path = self.home / ".claude.json"
        path.write_text("{not json")
        self.assertFalse(config.add_server(path, "computer", ENTRY))
        self.assertEqual(path.read_text(), "{not json")
        self.assertEqual([p.name for p in self.home.iterdir()], [".claude.json"])


if __name__ == "__main__":
    unittest.main()
