import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import sys
from contextlib import closing

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.export_sqlite import export_sqlite


class SQLiteExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "hasm_root"
        self.root.mkdir()
        ids = {
            "person": "00000000-0000-4000-8000-000000000001",
            "root": "00000000-0000-4000-8000-000000000002",
            "event": "00000000-0000-4000-8000-000000000003",
            "fact": "00000000-0000-4000-8000-000000000004",
            "link": "00000000-0000-4000-8000-000000000005",
            "related_link": "00000000-0000-4000-8000-000000000006",
        }
        self.ids = ids
        self.database = {
            "schema_version": 2,
            "person": [{
                "person_id": ids["person"], "life_experience_id": ids["root"],
                "person_name": "Ada", "person_description": "Researcher",
                "link": ["https://example.com/person"], "security_level": 1,
            }],
            "experience": [
                {"experience_id": ids["root"], "experience_name": "Life",
                 "experience_description": "", "link": [], "security_level": 0},
                {"experience_id": ids["event"], "experience_name": "Research",
                 "experience_description": "A study", "link": ["https://example.com/event"],
                 "security_level": 0},
            ],
            "experience_tree": [{"parent_id": ids["root"], "child_id": ids["event"]}],
            "fact": [{
                "fact_id": ids["fact"], "fact_name": "Published",
                "fact_description": "An objective event", "link": [],
                "occurred_at": "2025-01-01T10:00:00Z",
                "start_time": "2025-01-01T10:00:00Z", "end_time": "2025-01-01T10:30:00Z",
                "security_level": 0,
            }],
            "fact_experience": [{"fact_id": ids["fact"], "experience_id": ids["event"]}],
            "link": [
                {"link_id": ids["link"], "link_type": "supports", "link_description": "",
                 "link": [], "origin_entity_type": "Person", "origin_entity_id": ids["person"],
                 "target_entity_type": "Fact", "target_entity_id": ids["fact"], "security_level": 0},
                {"link_id": ids["related_link"], "link_type": "references", "link_description": "",
                 "link": [], "origin_entity_type": "Fact", "origin_entity_id": ids["fact"],
                 "target_entity_type": "Experience", "target_entity_id": ids["event"],
                 "security_level": 0},
            ],
            "link_relation": [{"link_id": ids["link"], "related_link_id": ids["related_link"]}],
            "sync_metadata": {
                "source_keys": {}, "assets_by_id": {}, "legacy_entities": [], "legacy_links": [],
            },
        }
        for table, rows in (
            ("PERSON", self.database["person"]),
            ("EXPERIENCE", self.database["experience"]),
            ("FACT", self.database["fact"]),
            ("LINK", self.database["link"]),
        ):
            id_field = {
                "PERSON": "person_id", "EXPERIENCE": "experience_id",
                "FACT": "fact_id", "LINK": "link_id",
            }[table]
            for row in rows:
                folder = self.root / table / row[id_field]
                folder.mkdir(parents=True)
                (folder / "main.md").write_text("---\n---\n", encoding="utf-8")
        (self.root / "hasm.db").write_text(json.dumps(self.database), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_creates_desktop_compatible_sqlite_and_model_relationships(self):
        output = export_sqlite(self.root, self.root / "main.db", False)
        with closing(sqlite3.connect(output)) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(connection.execute(
                "SELECT life_experience_id, person_description_path FROM person"
            ).fetchone(), (self.ids["root"], f"PERSON/{self.ids['person']}/main.md"))
            self.assertEqual(connection.execute(
                "SELECT person_id, person_name, person_description_path, birthday, die, link_ids, link FROM person"
            ).fetchone(), (
                self.ids["person"], "Ada", f"PERSON/{self.ids['person']}/main.md",
                "", "", f'["{self.ids["link"]}"]', '["https://example.com/person"]',
            ))
            self.assertEqual(connection.execute(
                "SELECT experience_id, person_id, experience_name, experience_description_path, "
                "parent_experience_ids, link_ids, link FROM experience WHERE experience_id = ?",
                (self.ids["event"],),
            ).fetchone(), (
                self.ids["event"], self.ids["person"], "Research",
                f"EXPERIENCE/{self.ids['event']}/main.md",
                f'["{self.ids["root"]}"]', f'["{self.ids["related_link"]}"]',
                '["https://example.com/event"]',
            ))
            self.assertEqual(connection.execute(
                "SELECT fact_id, fact_name, occurred_at, fact_description_path, experience_ids, "
                "person_ids, link_ids, link FROM fact"
            ).fetchone(), (
                self.ids["fact"], "Published", "2025-01-01T10:00:00Z",
                f"FACT/{self.ids['fact']}/main.md", f'["{self.ids["event"]}"]',
                f'["{self.ids["person"]}"]',
                f'["{self.ids["link"]}", "{self.ids["related_link"]}"]', "[]",
            ))
            self.assertEqual(connection.execute(
                "SELECT link_id, link_name, link_type, link_description_path, related_ids, link "
                "FROM link WHERE link_id = ?",
                (self.ids["link"],),
            ).fetchone(), (
                self.ids["link"], "supports", "supports", f"LINK/{self.ids['link']}/main.md",
                f'["{self.ids["related_link"]}"]', "[]",
            ))
            self.assertEqual(connection.execute(
                "SELECT parent_id, child_id FROM experience_tree"
            ).fetchone(), (self.ids["root"], self.ids["event"]))
            self.assertEqual(connection.execute(
                "SELECT fact_id, experience_id FROM fact_experience"
            ).fetchone(), (self.ids["fact"], self.ids["event"]))
            self.assertEqual(connection.execute(
                "SELECT link_id, related_link_id FROM link_relation"
            ).fetchone(), (self.ids["link"], self.ids["related_link"]))
            self.assertEqual(connection.execute(
                "SELECT person_id FROM experience WHERE experience_id = ?",
                (self.ids["event"],),
            ).fetchone()[0], self.ids["person"])
            self.assertEqual(connection.execute(
                "SELECT person_ids FROM fact"
            ).fetchone()[0], f'["{self.ids["person"]}"]')
            self.assertIn("origin_entity_type", {
                row[1] for row in connection.execute("PRAGMA table_info(link)")
            })
            self.assertIn("related_ids", {
                row[1] for row in connection.execute("PRAGMA table_info(link)")
            })

    def test_does_not_replace_existing_database_without_explicit_flag(self):
        output = self.root / "main.db"
        output.write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            export_sqlite(self.root, output, False)
        self.assertEqual(output.read_bytes(), b"keep")

    def test_rejects_dangling_relations(self):
        self.database["fact_experience"][0]["experience_id"] = "missing"
        (self.root / "hasm.db").write_text(json.dumps(self.database), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "FACT_EXPERIENCE"):
            export_sqlite(self.root, self.root / "main.db", False)


if __name__ == "__main__":
    unittest.main()
