import csv, re, random, unicodedata, sys
sys.path.insert(0, '.')
from hand1 import GREETINGS, PHONE, LOANS
from hand2 import MARKET, FAMILY
from hand3 import QUESTIONS, GENERAL
from hand4 import CONVERSATION, LONGER, INSTRUCTIONS, EXTRA
from templates import generate

cats = {'greetings': GREETINGS, 'phone': PHONE + INSTRUCTIONS, 'loans': LOANS, 'market': MARKET,
        'family': FAMILY, 'questions': QUESTIONS, 'general': GENERAL + LONGER,
        'conversation': CONVERSATION, 'loans ': ''}
rows = []
for c, txt in cats.items():
    for l in txt.strip().splitlines():
        if l.strip(): rows.append((l.strip(), c.strip()))
# EXTRA: assign by keyword
for l in EXTRA.strip().splitlines():
    l = l.strip()
    if not l: continue
    c = 'phone' if re.search(r'Finya|libenga|Mosalisi|zela moke|Telefone ya bureau|kozela', l, re.I) else \
        'loans' if re.search(r'crédit|groupe|remboursement|agent|formation|mokambi|niongo|kofuta|olaki|nafuti|Basi', l, re.I) else 'family'
    rows.append((l, c))
rows += generate()

OPEN = re.compile('[ɛɔƐƆ]'); TONE = re.compile('[áíóúÁÍÓÚǎěǐǒǔ]|[̀-ͯ]')
SYM = re.compile(r'[%$€£&@#/\\<>\[\]{}()=+*_|~^`]')
ABBR = re.compile(r'(^|[\s,.;:!?])(svp|stp|mr|mme|mlle|mrs|etc|fc|cdf|usd|km|kg|tel|n°|no\.)(?=$|[\s,.;:!?])', re.I)
SPLIT = re.compile(r'(^|\s)ko[\s-]+\w')
def issues(t):
    t = unicodedata.normalize('NFC', t); out = []
    if re.search(r'\d', t): out.append('digits')
    if OPEN.search(t): out.append('open-vowels')
    if TONE.search(t): out.append('tone-marks')
    if SYM.search(t): out.append('symbols')
    if ABBR.search(t): out.append('abbreviation')
    if SPLIT.search(t): out.append('spacing')
    if len(t) > 250: out.append('too-long')
    return out

seen = {}; clean = []; problems = []
for t, c in rows:
    t = unicodedata.normalize('NFC', re.sub(r'\s+', ' ', t)).strip()
    k = t.lower()
    if k in seen: problems.append(('dup', t)); continue
    seen[k] = c
    iss = issues(t)
    if iss: problems.append((','.join(iss), t))
    if not re.search(r'[.?!]$', t): problems.append(('no-final-punct', t))
    if 'plait' in t: problems.append(('plait', t))
    clean.append((t, c))

# deterministic interleave: shuffle within category, then round-robin weighted
R = random.Random(7)
by = {}
for t, c in clean: by.setdefault(c, []).append(t)
for v in by.values(): R.shuffle(v)
order = []
total = len(clean)
pos = {c: 0 for c in by}
while len(order) < total:
    # pick the category furthest behind its share
    best = min((c for c in by if pos[c] < len(by[c])), key=lambda c: (pos[c] + 1) / len(by[c]))
    order.append((by[best][pos[best]], best)); pos[best] += 1

with open('../koyokana-script-v1.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
    w.writerow(['text', 'category'])
    w.writerows(order)

from collections import Counter
print('total', len(order)); print(Counter(c for _, c in order))
print('problems', len(problems))
for p in problems: print(' ', p)
L = [len(t) for t, _ in order]; W = [len(t.split()) for t, _ in order]
print('chars min/avg/max', min(L), sum(L)/len(L), max(L)); print('words avg', sum(W)/len(W))
