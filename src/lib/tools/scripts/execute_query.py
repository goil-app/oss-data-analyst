#!/usr/bin/env python3
"""
MongoDB query runner for the data analyst sandbox.
Reads query params from stdin as JSON, executes via pymongo,
outputs { rows, columns, rowCount, executionTime } as JSON to stdout.
"""
import sys
import json
import os
import time
import re
from datetime import datetime

try:
    from pymongo import MongoClient
    from bson import ObjectId, Decimal128
except ImportError:
    print("pymongo not installed", file=sys.stderr)
    sys.exit(1)

OBJECT_ID_REGEX = re.compile(r'^[0-9a-fA-F]{24}$')


def deserialize_object_ids(value):
    """Recursively convert 24-hex strings to ObjectId (mirrors Node.js logic)."""
    if isinstance(value, str) and OBJECT_ID_REGEX.match(value):
        return ObjectId(value)
    if isinstance(value, list):
        return [deserialize_object_ids(v) for v in value]
    if isinstance(value, dict):
        return {k: deserialize_object_ids(v) for k, v in value.items()}
    return value


class MongoEncoder(json.JSONEncoder):
    """Serialize MongoDB types to JSON-safe values."""
    def default(self, obj):
        if isinstance(obj, ObjectId):
            return str(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, Decimal128):
            return float(str(obj))
        if isinstance(obj, bytes):
            return obj.hex()
        return super().default(obj)


def main():
    raw = sys.stdin.read()
    data = json.loads(raw)

    uri = os.environ.get('MONGODB_URI_DOCKER')
    if not uri:
        print("MONGODB_URI_DOCKER not set", file=sys.stderr)
        sys.exit(1)

    client = MongoClient(uri, serverSelectionTimeoutMS=10000)
    db = client[data['database']]
    collection = db[data['collection']]

    start = time.time()
    mode = data.get('mode', 'find')

    if mode == 'aggregate':
        pipeline = deserialize_object_ids(data.get('pipeline', []))
        rows = list(collection.aggregate(pipeline))
    else:
        filter_query = deserialize_object_ids(data.get('filter') or {})
        projection = data.get('projection')
        sort = data.get('sort')
        limit = data.get('limit', 100)
        skip = data.get('skip')

        cursor = collection.find(filter_query, projection)
        if sort:
            cursor = cursor.sort(list(sort.items()))
        if skip:
            cursor = cursor.skip(skip)
        if limit:
            cursor = cursor.limit(limit)
        rows = list(cursor)

    execution_time = int((time.time() - start) * 1000)
    columns = list(rows[0].keys()) if rows else []

    result = {
        "rows": rows,
        "columns": columns,
        "rowCount": len(rows),
        "executionTime": execution_time,
    }

    print(json.dumps(result, cls=MongoEncoder))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
