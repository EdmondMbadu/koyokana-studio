import random
from fr import fr
R = random.Random(20261008)

def fc(n): return f"{fr(n)} francs"
AMOUNTS = [500,1000,1500,2000,2500,3000,4500,5000,7500,10000,12000,15000,20000,25000,30000,35000,40000,45000,50000,60000,75000,80000,90000,100000,120000,150000,180000,200000,250000,300000,450000,500000,750000,1000000,1200000,1500000]
SMALL = [200,300,500,700,1000,1500,2000,2500,3000,3500,5000,6000,8000]
USD = [5,10,20,25,50,75,100,150,200,250,300,500]
RATES = [2700,2750,2800,2850,2900,2950,3000]
F_WHEN = ['lelo','lobi','poso oyo','poso ekoya','liboso ya samedi','na lundi','liboso ya suka ya sanza','sanza ekoya','na mokolo ya mercredi']
P_WHEN = ['lobi','poso eleki','sanza eleki','na lundi','na mercredi','mikolo mibale eleki','na ntongo ya lelo']
NAMES = ['Mama Thérèse','Mama Nsimba','Mama Mbuyi','Mama Kapinga','Mama Mujinga','Mama Ngalula','Mama Bijou','Mama Espérance','Mama Antoinette','Mama Pauline','Mama Godelive','Mama Chantal','Mama Solange','Mama Nzuzi','Mama Clémentine','Mama Odette','Mama Julienne','Mama Béatrice','Mama Mamie','Mama Grâce','Papa Jean','Papa Albert','Papa Fiston','Papa Mutombo','Papa Kabeya','Papa Didier']
ITEMS = ['kilo ya loso','sac ya loso','bidon ya mafuta','kilo ya sukali','paquet ya mungwa','mbisi ya kokauka','makayabu','nsoso moko','kilo ya nyama','liboke ya pondu','makemba','kwanga','mapa','sac ya farine','ntaba moko','tomate','oignons','pili-pili','madesu','matembele']
MARKETS = ['Gambela','Matete','Liberté','Somba Zikita','Bandal','Kintambo','Lemba','Masina']
COMMUNES = ['Matete','Lingwala','Kintambo','Bandalungwa','Masina','Ndjili','Limete','Kalamu','Ngaliema','Lemba','Ngaba','Kimbanseke','Barumbu','Kasa-Vubu','Selembao','Makala','Bumbu','Ngiri-Ngiri','Gombe']
DAYS = ['lundi','mardi','mercredi','jeudi','vendredi','samedi']
TIMES = ['na huit heures','na neuf heures et demie','na dix heures','na onze heures','na midi','na deux heures','na trois heures et demie','na ngonga ya mwambe ya ntongo','na ngonga ya libwa ya ntongo','na ngonga ya zomi','na ngonga ya mibale ya mpokwa','na ngonga ya minei ya mpokwa']
DATES = ['le premier novembre','le deux novembre','le cinq décembre','le dix octobre','le quinze janvier','le vingt février','le vingt-cinq mars','le trente avril','le douze mai','le dix-huit juin','le vingt et un juillet','le trois août','le neuf septembre','le quatorze octobre','le vingt-huit novembre','le trente et un décembre']
LN = {1:'moko',2:'mibale',3:'misato',4:'minei',5:'mitano',6:'motoba',7:'sambo',8:'mwambe',9:'libwa',10:'zomi',11:'zomi na moko',12:'zomi na mibale',15:'zomi na mitano'}
DIG = ['zéro','un','deux','trois','quatre','cinq','six','sept','huit','neuf']
WALLETS = ['M-Pesa','Airtel Money','Orange Money']

def phone():
    pre = R.choice(['081','082','084','085','089','097','099'])
    rest = ''.join(R.choice('0123456789') for _ in range(7))
    groups = [pre, rest[:3], rest[3:5], rest[5:]]
    return ', '.join(' '.join(DIG[int(c)] for c in g) for g in groups)

def amt(): return fc(R.choice(AMOUNTS))
def small(): return fc(R.choice(SMALL))

TEMPLATES = [
 ('money', lambda: f"Niongo na yo ezali {amt()}.", 14),
 ('money', lambda: f"{R.choice(NAMES)}, niongo na yo ezali {amt()}.", 14),
 ('money', lambda: f"Okoki kofuta {amt()} {R.choice(F_WHEN)}.", 14),
 ('money', lambda: f"Ofutaki {amt()} {R.choice(P_WHEN)}.", 12),
 ('money', lambda: f"Remboursement ya poso oyo ezali {amt()}.", 10),
 ('money', lambda: f"Crédit na yo ya {amt()} endimami.", 10),
 ('money', lambda: f"Nalingi kodefa {amt()} mpo na mombongo na ngai.", 12),
 ('money', lambda: f"Natindi {amt()} na {R.choice(WALLETS)}.", 10),
 ('money', lambda: f"Otikali na {amt()} ya kofuta.", 10),
 ('money', lambda: f"Épargne na yo ekomi {amt()}.", 8),
 ('money', lambda: f"{R.choice(NAMES)} afuti {amt()} lelo na ntongo.", 10),
 ('money', lambda: f"Ntalo ya {R.choice(ITEMS)} ezali {small()} lelo.", 14),
 ('money', lambda: f"Nateki {R.choice(ITEMS)} ya {small()} na zando ya {R.choice(MARKETS)}.", 12),
 ('money', lambda: f"Nasombi {R.choice(ITEMS)} na {small()}.", 10),
 ('money', lambda: f"Taxi kino {R.choice(COMMUNES)} ezali {fc(R.choice([500,700,1000,1500,2000]))}.", 8),
 ('money', lambda: f"Dollar moko ezali {fc(R.choice(RATES))} lelo.", 6),
 ('money', lambda: f"Nabongoli {fr(R.choice(USD))} dollars na francs.", 6),
 ('money', lambda: f"Crédit ya {fr(R.choice(USD))} dollars ekoki mpo na mombongo na ngai.", 6),
 ('dates', lambda: f"Mokolo ya kofuta ezali {R.choice(DATES)}.", 12),
 ('dates', lambda: f"Réunion ya groupe ekozala {R.choice(DAYS)} {R.choice(TIMES)}.", 12),
 ('dates', lambda: f"Formation ekobanda {R.choice(DATES)} {R.choice(TIMES)}.", 8),
 ('dates', lambda: f"Tokokutana na bureau ya {R.choice(COMMUNES)} {R.choice(DAYS)} oyo ekoya.", 12),
 ('dates', lambda: f"Bureau ekofungwama {R.choice(TIMES)}.", 6),
 ('dates', lambda: f"Agent akoya kotala yo na zando ya {R.choice(MARKETS)} {R.choice(DAYS)}.", 8),
 ('numbers', lambda: f"Nazali na bana {LN[R.choice([2,3,4,5,6,7])]}.", 6),
 ('numbers', lambda: f"Groupe na biso ezali na basi {LN[R.choice([5,6,7,8,9,10,11,12,15])]}.", 8),
 ('numbers', lambda: f"Nateki mbisi {LN[R.choice([3,4,5,6,7,8,9,10,12,15])]} lelo.", 8),
 ('numbers', lambda: f"Ozali na retard ya mikolo {LN[R.choice([2,3,4,5,6,7,8,9,10])]}.", 8),
 ('numbers', lambda: f"{R.choice(NAMES)} afandi na {R.choice(COMMUNES)} na bana {LN[R.choice([2,3,4,5,6])]}.", 8),
 ('numbers', lambda: f"Nimero na ngai ezali {phone()}.", 12),
 ('numbers', lambda: f"Benga ngai na nimero {phone()}.", 8),
 ('numbers', lambda: f"Intérêt ezali {fr(R.choice([1,2,3,4,5]))} pour cent na sanza.", 5),
 ('numbers', lambda: f"Ofuti mbala {LN[R.choice([2,3,4,5,6,7,8,9,10])]} kozanga retard.", 8),
]

def generate():
    out = []
    for cat, fn, n in TEMPLATES:
        seen = set(); tries = 0
        while len(seen) < n and tries < n * 50:
            seen.add(fn()); tries += 1
        out += [(t, cat) for t in sorted(seen)]
    return out
