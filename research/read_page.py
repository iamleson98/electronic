import json, re, sys, subprocess
url = sys.argv[1]
maxlen = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
try:
    out = subprocess.run(['z-ai', 'function', '-n', 'page_reader', '-a', json.dumps({'url': url})],
                         capture_output=True, text=True, timeout=110).stdout
except Exception as e:
    print("FETCH ERROR", e); sys.exit(0)
start = out.find('{')
if start < 0:
    print("NO JSON"); sys.exit(0)
try:
    data, _ = json.JSONDecoder().raw_decode(out[start:])
except Exception as e:
    print("PARSE ERROR", e); sys.exit(0)
d = data.get('data', {})
content = d.get('content') or d.get('text') or d.get('html') or ''
# remove script/style blocks
content = re.sub(r'(?s)<(script|style|noscript)[^>]*>.*?</\1>', ' ', content)
content = re.sub(r'@font-face\s*\{[^}]*\}', ' ', content)
content = re.sub(r'<[^>]+>', ' ', content)
content = re.sub(r'&nbsp;', ' ', content)
content = re.sub(r'\s+', ' ', content)
print(content[:maxlen])
