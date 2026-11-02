"""Run real PostgreSQL migration/invariant checks without a daemon or sockets.
Uses a disposable rootless cluster; never connects to the host database.
"""
from pathlib import Path
import os
import subprocess
import tempfile

bin_dir = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/18/bin'))
with tempfile.TemporaryDirectory(prefix='budgey-pgtest-') as temp:
    data = Path(temp) / 'data'
    subprocess.run([str(bin_dir / 'initdb'), '-D', str(data), '-A', 'trust', '--no-locale', '-E', 'UTF8'], check=True, capture_output=True)
    scripts = [*sorted(Path('migrations').glob('*.sql')), Path('tests/postgres-invariants.sql')]
    # Standalone mode accepts one complete query string per line. Strip only full-line comments.
    sql = '\n'.join(' '.join(line for line in p.read_text().splitlines() if not line.strip().startswith('--')) for p in scripts) + '\n'
    result = subprocess.run([str(bin_dir / 'postgres'), '--single', '-D', str(data), 'postgres'], input=sql, text=True, capture_output=True)
    combined = result.stdout + result.stderr
    if result.returncode or 'ERROR:' in combined or 'FATAL:' in combined or 'PASS:' not in combined:
        print(combined)
        raise SystemExit(1)
    print('PostgreSQL 18: both migrations applied to a fresh disposable cluster.')
    print(next(line for line in combined.splitlines() if 'PASS:' in line))
