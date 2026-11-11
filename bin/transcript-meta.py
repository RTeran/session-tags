import glob
import json
import os
import sys

PROJECTS = os.path.expanduser('~/.claude/projects')


def is_counted_user(entry):
    if entry.get('isMeta'):
        return False
    content = (entry.get('message') or {}).get('content')
    if isinstance(content, str):
        return content.strip() != ''
    if isinstance(content, list):
        return any(block.get('type') in ('text', 'image', 'document') for block in content)
    return False


def is_counted_assistant(entry):
    content = (entry.get('message') or {}).get('content')
    if not isinstance(content, list):
        return False
    return any(
        block.get('type') == 'text' and isinstance(block.get('text'), str) and block['text'].strip() != ''
        for block in content
    )


def first_prompt(entry):
    content = (entry.get('message') or {}).get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ' '.join(block.get('text', '') for block in content if block.get('type') == 'text')
    return ''


def read_meta(path):
    meta = {
        'messageCount': 0,
        'firstPrompt': '',
        'customTitle': None,
        'aiTitle': None,
        'agentName': None,
        'gitBranch': None,
        'sessionKind': None,
        'prNumber': None,
        'prRepository': None,
        'modified': None,
        'cwd': None,
        'entrypoint': None,
    }
    with open(path, encoding='utf-8', errors='replace') as lines:
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            kind = entry.get('type')
            if kind == 'custom-title':
                meta['customTitle'] = entry.get('customTitle') or meta['customTitle']
            elif kind == 'ai-title':
                meta['aiTitle'] = entry.get('aiTitle') or meta['aiTitle']
            elif kind == 'agent-name':
                meta['agentName'] = entry.get('agentName') or meta['agentName']
            elif kind == 'pr-link':
                meta['prNumber'] = entry.get('prNumber')
                meta['prRepository'] = entry.get('prRepository')
            elif kind in ('user', 'assistant') and not entry.get('isSidechain'):
                meta['gitBranch'] = entry.get('gitBranch') or meta['gitBranch']
                meta['sessionKind'] = meta['sessionKind'] or entry.get('sessionKind')
                meta['modified'] = entry.get('timestamp') or meta['modified']
                meta['cwd'] = entry.get('cwd') or meta['cwd']
                meta['entrypoint'] = meta['entrypoint'] or entry.get('entrypoint')
                if kind == 'user' and is_counted_user(entry):
                    meta['messageCount'] += 1
                    prompt = ' '.join(first_prompt(entry).split())
                    if meta['firstPrompt'] == '' and 'isCompactSummary' not in entry and not prompt.startswith('<'):
                        meta['firstPrompt'] = prompt[:200]
                elif kind == 'assistant' and is_counted_assistant(entry):
                    meta['messageCount'] += 1
    return meta


def main():
    cache_path = sys.argv[1]
    paths_by_id = {}
    for path in glob.glob(os.path.join(PROJECTS, '*', '*.jsonl')):
        session_id = os.path.basename(path)[: -len('.jsonl')]
        current = paths_by_id.get(session_id)
        if current is None or os.path.getmtime(path) > os.path.getmtime(current):
            paths_by_id[session_id] = path
    try:
        with open(cache_path, encoding='utf-8') as cache_file:
            cache = json.load(cache_file)
    except (OSError, ValueError):
        cache = {}

    result = {}
    fresh_cache = {}
    for session_id, path in paths_by_id.items():
        stat = os.stat(path)
        stamp = [stat.st_mtime, stat.st_size]
        cached = cache.get(session_id)
        if cached and cached.get('stamp') == stamp and cached.get('path') == path and 'entrypoint' in cached['meta']:
            meta = cached['meta']
        else:
            meta = read_meta(path)
        meta['fileSize'] = stat.st_size
        fresh_cache[session_id] = {'path': path, 'stamp': stamp, 'meta': meta}
        result[session_id] = meta

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    temporary = f'{cache_path}.{os.getpid()}'
    with open(temporary, 'w', encoding='utf-8') as cache_file:
        json.dump(fresh_cache, cache_file)
    os.replace(temporary, cache_path)
    json.dump(result, sys.stdout)


main()
