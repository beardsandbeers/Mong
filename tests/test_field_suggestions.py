from datetime import datetime

from bson import Binary, Decimal128, ObjectId
from bson.code import Code

from mong.field_suggestions import sample_mapping


def test_samples_respect_overrides_closed_scopes_and_nested_arrays():
    definition = {"mappings": {"dynamic": True, "fields": {
        "_id": {"type": "token"},
        "private": {"type": "document", "fields": {"public": {"type": "string"}}},
        "items": {"type": "embeddedDocuments", "dynamic": True},
    }}}
    result = sample_mapping(definition, [{
        "_id": "id", "full_name": "Alex Example", "active": True,
        "private": {"secret": "hidden", "public": "shown"},
        "items": [{"name": "one"}, {"price": 2}],
        "address": {"city": "Town"}, "mixed": [1, "one", None],
    }])
    fields = result["fields"]
    assert "_id" not in fields  # explicit token type is retained by the editor
    assert fields["full_name"] == [{"type": "string"}]
    assert fields["active"] == [{"type": "boolean"}]
    assert fields["private"][0]["fields"] == {}
    assert fields["private"][0]["dynamic"] is False
    assert fields["items"][0]["fields"] == {"name": [{"type": "string"}], "price": [{"type": "number"}]}
    assert fields["address"][0]["dynamic"] is True
    assert fields["address"][0]["fields"]["city"] == [{"type": "string"}]
    assert fields["mixed"] == [{"type": "number"}, {"type": "string"}]


def test_type_sets_apply_to_nested_dynamic_fields_under_static_root():
    definition = {
        "mappings": {"fields": {"details": {"type": "document", "dynamic": {"typeSet": "tokens"}}}},
        "typeSets": [{"name": "tokens", "types": [{"type": "token"}]}],
    }
    result = sample_mapping(definition, [{"ignored": "x", "details": {"name": "Alex", "age": 20, "nested": {"name": "A"}}}])
    assert set(result["fields"]) == {"details"}
    nested = result["fields"]["details"][0]["fields"]
    assert nested["name"] == [{"type": "token"}] and "age" not in nested
    assert nested["nested"][0]["fields"]["name"] == [{"type": "token"}]


def test_bson_types_are_not_guessed_from_string_contents():
    result = sample_mapping({"mappings": {"dynamic": True}}, [{
        "date": datetime(2026, 1, 1), "oid": ObjectId(), "uuid": Binary(b"0" * 16, subtype=4),
        "date_string": "2026-01-01", "oid_string": str(ObjectId()),
        "unsupported": Decimal128("1.5"), "binary": Binary(b"x"), "code": Code("x"),
    }])
    assert result["fields"] == {
        "date": [{"type": "date"}], "oid": [{"type": "objectId"}], "uuid": [{"type": "uuid"}],
        "date_string": [{"type": "string"}], "oid_string": [{"type": "string"}],
    }
