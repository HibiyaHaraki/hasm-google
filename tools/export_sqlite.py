#!/usr/bin/env python3
"""Convert an Apps Script HASM JSON folder into the desktop app's SQLite workspace."""

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit


TABLE_IDS = {
    "person": ("person_id", "PERSON"),
    "experience": ("experience_id", "EXPERIENCE"),
    "fact": ("fact_id", "FACT"),
    "link": ("link_id", "LINK"),
}
NIL_UUID = "00000000-0000-0000-0000-000000000000"
ENTITY_TYPE_TABLES = {
    "Person": "PERSON",
    "Experience": "EXPERIENCE",
    "Fact": "FACT",
}


def fail(message):
    raise ValueError(message)


def validate_links(values, label):
    if not isinstance(values, list):
        fail(f"{label}.link must be a URL array.")
    for value in values:
        if not isinstance(value, str) or any(character.isspace() for character in value):
            fail(f"{label}.link contains an invalid URL.")
        try:
            parsed = urlsplit(value)
            valid_port = parsed.port is None or 0 < parsed.port <= 65535
        except ValueError:
            valid_port = False
            parsed = None
        if (not parsed or parsed.scheme.lower() not in ("http", "https") or
                not parsed.hostname or parsed.username is not None or
                parsed.password is not None or not valid_port):
            fail(f"{label}.link contains an invalid HTTP(S) URL.")


def load_model(root):
    if not root.is_dir():
        fail(f"HASM root is not a directory: {root}")
    for entity_type in ("PERSON", "EXPERIENCE", "FACT", "LINK"):
        if not (root / entity_type).is_dir():
            fail(f"Missing HASM entity folder: {root / entity_type}")
    database_path = root / "hasm.db"
    if not database_path.is_file():
        fail(f"Missing JSON model database: {database_path}")
    try:
        database = json.loads(database_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"Cannot read JSON model database: {error}")
    if not isinstance(database, dict) or database.get("schema_version") != 2:
        fail("Expected schema_version 2 in hasm.db.")
    required_tables = [
        "person", "experience", "experience_tree", "fact",
        "fact_experience", "link", "link_relation",
    ]
    for table in required_tables:
        if not isinstance(database.get(table), list):
            fail(f"Missing or invalid HASM table: {table}")
    metadata = database.get("sync_metadata", {})
    if not isinstance(metadata, dict) or not isinstance(metadata.get("legacy_entities", []), list):
        fail("Invalid legacy entity metadata.")

    entities = {}
    rows_by_table = {}
    for table, (id_field, entity_type) in TABLE_IDS.items():
        rows = database[table]
        rows_by_table[table] = rows
        if not all(isinstance(row, dict) for row in rows):
            fail(f"{table} contains a non-object row.")
        for row in rows:
            entity_id = row.get(id_field)
            try:
                uuid.UUID(entity_id)
            except (TypeError, ValueError, AttributeError):
                fail(f"{table} contains an invalid UUID in {id_field}.")
            if entity_id in entities:
                fail(f"{table} contains a missing or duplicate {id_field}.")
            entities[entity_id] = entity_type
            validate_links(row.get("link"), f"{entity_type}/{entity_id}")
            level = row.get("security_level")
            if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 5:
                fail(f"{entity_type} security_level must be an integer from 0 to 5.")
            if table == "person" and (
                    not isinstance(row.get("person_name"), str) or not row["person_name"].strip() or
                    not isinstance(row.get("person_description"), str)):
                fail(f"PERSON {entity_id} has invalid names or descriptions.")
            if table == "experience" and (
                    not isinstance(row.get("experience_name"), str) or not row["experience_name"].strip() or
                    not isinstance(row.get("experience_description"), str)):
                fail(f"EXPERIENCE {entity_id} has invalid names or descriptions.")
            if table == "fact" and (
                    not isinstance(row.get("fact_name"), str) or not row["fact_name"].strip() or
                    not isinstance(row.get("fact_description"), str) or
                    not isinstance(row.get("occurred_at"), str)):
                fail(f"FACT {entity_id} has invalid names, descriptions, or occurrence time.")
            if table == "link" and (
                    not isinstance(row.get("link_type"), str) or not row["link_type"].strip() or
                    not isinstance(row.get("link_description"), str)):
                fail(f"LINK {entity_id} has invalid type or description.")

    people = {row["person_id"]: row for row in rows_by_table["person"]}
    experiences = {row["experience_id"]: row for row in rows_by_table["experience"]}
    facts = {row["fact_id"]: row for row in rows_by_table["fact"]}
    links = {row["link_id"]: row for row in rows_by_table["link"]}
    for person in people.values():
        if (not isinstance(person.get("life_experience_id"), str) or
                person["life_experience_id"] not in experiences):
            fail(f"PERSON {person['person_id']} has a dangling life_experience_id.")
    for row in database["experience_tree"]:
        if (not isinstance(row, dict) or not isinstance(row.get("parent_id"), str) or
                not isinstance(row.get("child_id"), str) or row["parent_id"] not in experiences or
                row["child_id"] not in experiences or row["parent_id"] == row["child_id"]):
            fail("Invalid EXPERIENCE_TREE row.")
    for row in database["fact_experience"]:
        if (not isinstance(row, dict) or not isinstance(row.get("fact_id"), str) or
                not isinstance(row.get("experience_id"), str) or row["fact_id"] not in facts or
                row["experience_id"] not in experiences):
            fail("Invalid FACT_EXPERIENCE row.")
    for link in links.values():
        if (not isinstance(link.get("origin_entity_type"), str) or
                link["origin_entity_type"] not in ENTITY_TYPE_TABLES or
                not isinstance(link.get("target_entity_type"), str) or
                link["target_entity_type"] not in ENTITY_TYPE_TABLES or
                not isinstance(link.get("origin_entity_id"), str) or
                not isinstance(link.get("target_entity_id"), str) or
                entities.get(link.get("origin_entity_id")) != ENTITY_TYPE_TABLES[link["origin_entity_type"]] or
                entities.get(link.get("target_entity_id")) != ENTITY_TYPE_TABLES[link["target_entity_type"]] or
                link["origin_entity_id"] == link["target_entity_id"]):
            fail(f"LINK {link['link_id']} has invalid endpoints.")
    for row in database["link_relation"]:
        if (not isinstance(row, dict) or not isinstance(row.get("link_id"), str) or
                not isinstance(row.get("related_link_id"), str) or row["link_id"] not in links or
                row["related_link_id"] not in links or row["link_id"] == row["related_link_id"]):
            fail("Invalid LINK_RELATION row.")
    for table, columns in (
            ("experience_tree", ("parent_id", "child_id")),
            ("fact_experience", ("fact_id", "experience_id")),
            ("link_relation", ("link_id", "related_link_id"))):
        relations = [(row[columns[0]], row[columns[1]]) for row in database[table]]
        if len(relations) != len(set(relations)):
            fail(f"{table} contains duplicate relationships.")
    for entity_type, rows in (("PERSON", people.values()), ("EXPERIENCE", experiences.values()),
                              ("FACT", facts.values()), ("LINK", links.values())):
        for row in rows:
            if not (root / entity_type / row[TABLE_IDS[entity_type.lower()][0]] / "main.md").is_file():
                fail(f"Missing Markdown entity file for {entity_type}/{row[TABLE_IDS[entity_type.lower()][0]]}.")
    return database, entities


def build_compatibility_data(database):
    people = {row["person_id"]: row for row in database["person"]}
    experiences = {row["experience_id"]: row for row in database["experience"]}
    facts = {row["fact_id"]: row for row in database["fact"]}
    links = {row["link_id"]: row for row in database["link"]}
    parents = {entity_id: [] for entity_id in experiences}
    for relation in database["experience_tree"]:
        parents[relation["child_id"]].append(relation["parent_id"])
    related_links = {entity_id: [] for entity_id in links}
    for relation in database["link_relation"]:
        related_links[relation["link_id"]].append(relation["related_link_id"])

    owners = {person["life_experience_id"]: person_id for person_id, person in people.items()}
    for _ in range(len(experiences)):
        changed = False
        for experience_id, parent_ids in parents.items():
            if experience_id not in owners:
                owner = next((owners[parent_id] for parent_id in parent_ids if parent_id in owners), None)
                if owner:
                    owners[experience_id] = owner
                    changed = True
        if not changed:
            break

    person_links = {entity_id: [] for entity_id in people}
    experience_links = {entity_id: [] for entity_id in experiences}
    fact_links = {entity_id: [] for entity_id in facts}
    for link in links.values():
        for entity_type, entity_id in (
            (ENTITY_TYPE_TABLES[link["origin_entity_type"]], link["origin_entity_id"]),
            (ENTITY_TYPE_TABLES[link["target_entity_type"]], link["target_entity_id"]),
        ):
            target = {
                "PERSON": person_links,
                "EXPERIENCE": experience_links,
                "FACT": fact_links,
            }[entity_type][entity_id]
            if link["link_id"] not in target:
                target.append(link["link_id"])

    fact_people = {entity_id: [] for entity_id in facts}
    for relation in database["fact_experience"]:
        owner = owners.get(relation["experience_id"])
        if owner and owner not in fact_people[relation["fact_id"]]:
            fact_people[relation["fact_id"]].append(owner)

    return {
        "people": people,
        "experiences": experiences,
        "facts": facts,
        "links": links,
        "parents": parents,
        "related_links": related_links,
        "owners": owners,
        "person_links": person_links,
        "experience_links": experience_links,
        "fact_links": fact_links,
        "fact_people": fact_people,
    }


def create_database(destination, database, compat):
    connection = sqlite3.connect(destination)
    try:
        connection.executescript("""
            PRAGMA foreign_keys = OFF;
            CREATE TABLE person (
                person_id TEXT PRIMARY KEY,
                life_experience_id TEXT NOT NULL,
                person_name TEXT NOT NULL DEFAULT '',
                person_description TEXT NOT NULL DEFAULT '',
                person_description_path TEXT NOT NULL DEFAULT '',
                birthday TEXT NOT NULL DEFAULT '',
                die TEXT NOT NULL DEFAULT '',
                link TEXT NOT NULL DEFAULT '[]',
                link_ids TEXT NOT NULL DEFAULT '[]',
                security_level INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (life_experience_id) REFERENCES experience(experience_id)
            );
            CREATE TABLE experience (
                experience_id TEXT PRIMARY KEY,
                experience_name TEXT NOT NULL DEFAULT '',
                experience_description TEXT NOT NULL DEFAULT '',
                experience_description_path TEXT NOT NULL DEFAULT '',
                person_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
                link TEXT NOT NULL DEFAULT '[]',
                parent_experience_ids TEXT NOT NULL DEFAULT '[]',
                link_ids TEXT NOT NULL DEFAULT '[]',
                security_level INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE experience_tree (
                parent_id TEXT NOT NULL,
                child_id TEXT NOT NULL,
                PRIMARY KEY (parent_id, child_id),
                FOREIGN KEY (parent_id) REFERENCES experience(experience_id),
                FOREIGN KEY (child_id) REFERENCES experience(experience_id)
            );
            CREATE TABLE fact (
                fact_id TEXT PRIMARY KEY,
                fact_name TEXT NOT NULL DEFAULT '',
                fact_description TEXT NOT NULL DEFAULT '',
                fact_description_path TEXT NOT NULL DEFAULT '',
                link TEXT NOT NULL DEFAULT '[]',
                occurred_at TEXT NOT NULL DEFAULT '',
                start_time TEXT NOT NULL DEFAULT '',
                end_time TEXT NOT NULL DEFAULT '',
                experience_ids TEXT NOT NULL DEFAULT '[]',
                person_ids TEXT NOT NULL DEFAULT '[]',
                link_ids TEXT NOT NULL DEFAULT '[]',
                security_level INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE fact_experience (
                fact_id TEXT NOT NULL,
                experience_id TEXT NOT NULL,
                PRIMARY KEY (fact_id, experience_id),
                FOREIGN KEY (fact_id) REFERENCES fact(fact_id),
                FOREIGN KEY (experience_id) REFERENCES experience(experience_id)
            );
            CREATE TABLE link (
                link_id TEXT PRIMARY KEY,
                link_type TEXT NOT NULL DEFAULT '',
                link_description TEXT NOT NULL DEFAULT '',
                link_description_path TEXT NOT NULL DEFAULT '',
                link TEXT NOT NULL DEFAULT '[]',
                link_name TEXT NOT NULL DEFAULT '',
                origin_entity_type TEXT NOT NULL,
                origin_entity_id TEXT NOT NULL,
                target_entity_type TEXT NOT NULL,
                target_entity_id TEXT NOT NULL,
                related_ids TEXT NOT NULL DEFAULT '[]',
                security_level INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE link_relation (
                link_id TEXT NOT NULL,
                related_link_id TEXT NOT NULL,
                PRIMARY KEY (link_id, related_link_id),
                FOREIGN KEY (link_id) REFERENCES link(link_id),
                FOREIGN KEY (related_link_id) REFERENCES link(link_id)
            );
            CREATE INDEX idx_person_sort
                ON person(COALESCE(NULLIF(person_name, ''), person_id));
            CREATE INDEX idx_experience_sort
                ON experience(COALESCE(NULLIF(experience_name, ''), experience_id));
            CREATE INDEX idx_fact_sort
                ON fact(COALESCE(NULLIF(fact_name, ''), fact_id));
            CREATE INDEX idx_link_sort
                ON link(COALESCE(NULLIF(link_name, ''), link_id));
            CREATE INDEX idx_experience_person ON experience(person_id);
        """)
        connection.execute("BEGIN")
        for entity_id, row in compat["people"].items():
            connection.execute(
                """INSERT INTO person
                   (person_id, life_experience_id, person_name, person_description,
                    person_description_path, link, link_ids, security_level)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (entity_id, row["life_experience_id"], row["person_name"], row["person_description"],
                 f"PERSON/{entity_id}/main.md", json.dumps(row["link"], ensure_ascii=False),
                 json.dumps(compat["person_links"][entity_id]), row["security_level"]),
            )
        for entity_id, row in compat["experiences"].items():
            connection.execute(
                """INSERT INTO experience
                   (experience_id, experience_name, experience_description,
                    experience_description_path, person_id, link, parent_experience_ids,
                    link_ids, security_level)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (entity_id, row["experience_name"], row["experience_description"],
                 f"EXPERIENCE/{entity_id}/main.md", compat["owners"].get(entity_id, NIL_UUID),
                 json.dumps(row["link"], ensure_ascii=False), json.dumps(compat["parents"][entity_id]),
                 json.dumps(compat["experience_links"][entity_id]), row["security_level"]),
            )
        for entity_id, row in compat["facts"].items():
            experience_ids = [
                relation["experience_id"] for relation in database["fact_experience"]
                if relation["fact_id"] == entity_id
            ]
            connection.execute(
                """INSERT INTO fact
                   (fact_id, fact_name, fact_description, fact_description_path, link,
                    occurred_at, start_time, end_time, experience_ids, person_ids,
                    link_ids, security_level)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (entity_id, row["fact_name"], row["fact_description"], f"FACT/{entity_id}/main.md",
                 json.dumps(row["link"], ensure_ascii=False), row["occurred_at"], row.get("start_time", ""),
                 row.get("end_time", ""), json.dumps(experience_ids), json.dumps(compat["fact_people"][entity_id]),
                 json.dumps(compat["fact_links"][entity_id]), row["security_level"]),
            )
        for entity_id, row in compat["links"].items():
            connection.execute(
                """INSERT INTO link
                   (link_id, link_type, link_description, link_description_path, link,
                    link_name, origin_entity_type, origin_entity_id,
                    target_entity_type, target_entity_id, related_ids, security_level)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (entity_id, row["link_type"], row["link_description"], f"LINK/{entity_id}/main.md",
                 json.dumps(row["link"], ensure_ascii=False), row["link_type"],
                 row["origin_entity_type"], row["origin_entity_id"], row["target_entity_type"],
                 row["target_entity_id"], json.dumps(compat["related_links"][entity_id]),
                 row["security_level"]),
            )
        for table in ("experience_tree", "fact_experience", "link_relation"):
            columns = {
                "experience_tree": ("parent_id", "child_id"),
                "fact_experience": ("fact_id", "experience_id"),
                "link_relation": ("link_id", "related_link_id"),
            }[table]
            connection.executemany(
                f"INSERT INTO {table} ({columns[0]}, {columns[1]}) VALUES (?, ?)",
                [(row[columns[0]], row[columns[1]]) for row in database[table]],
            )
        connection.execute("PRAGMA user_version = 2")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def export_sqlite(root, output, overwrite):
    root = root.resolve()
    database, _ = load_model(root)
    compat = build_compatibility_data(database)
    output = output.resolve()
    if output.exists() and not overwrite:
        fail(f"Output already exists: {output}. Pass --overwrite only if replacing it is intended.")
    output.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=output.name + ".", suffix=".tmp", dir=output.parent
    )
    os.close(file_descriptor)
    temporary = Path(temporary_name)
    try:
        create_database(temporary, database, compat)
        if output.exists() and not overwrite:
            fail(f"Output already exists: {output}.")
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hasm_root", type=Path, help="Local copy of the hasm_root Drive folder")
    parser.add_argument("--output", type=Path, help="SQLite output path (default: <hasm_root>/main.db)")
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing output database")
    arguments = parser.parse_args()
    output = arguments.output or arguments.hasm_root / "main.db"
    try:
        result = export_sqlite(arguments.hasm_root, output, arguments.overwrite)
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f"SQLite export failed: {error}", file=sys.stderr)
        return 1
    print(f"Created HASM desktop SQLite database: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
