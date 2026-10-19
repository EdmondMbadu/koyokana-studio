U = ['zéro','un','deux','trois','quatre','cinq','six','sept','huit','neuf','dix','onze','douze','treize','quatorze','quinze','seize']
T = {20:'vingt',30:'trente',40:'quarante',50:'cinquante',60:'soixante'}
def below100(n):
    if n <= 16: return U[n]
    if n < 20: return 'dix-' + U[n-10]
    if n < 70:
        t, u = (n//10)*10, n%10
        if u == 0: return T[t]
        if u == 1: return T[t] + ' et un'
        return T[t] + '-' + U[u]
    if n < 80:
        r = n - 60
        if r == 11: return 'soixante et onze'
        return 'soixante-' + below100(r)
    r = n - 80
    if r == 0: return 'quatre-vingts'
    return 'quatre-vingt-' + below100(r)
def below1000(n):
    h, r = divmod(n, 100)
    if h == 0: return below100(r)
    head = 'cent' if h == 1 else U[h] + ' cent'
    if r == 0: return head + ('s' if h > 1 else '')
    return head + ' ' + below100(r)
def fr(n):
    if n < 1000: return below1000(n)
    if n < 1000000:
        th, r = divmod(n, 1000)
        if th == 1:
            head = 'mille'
        else:
            w = below1000(th)
            if w.endswith('cents') or w.endswith('vingts'): w = w[:-1]   # deux cent mille, quatre-vingt mille
            head = w + ' mille'
        return head if r == 0 else head + ' ' + below1000(r)
    m, r = divmod(n, 1000000)
    head = 'un million' if m == 1 else fr(m) + ' millions'
    return head if r == 0 else head + ' ' + fr(r)
if __name__ == '__main__':
    for n in [1,16,17,21,31,61,70,71,72,77,80,81,90,91,99,100,101,180,200,250,500,1000,1500,2000,2500,10000,15000,21000,80000,85000,100000,180000,200000,250000,500000,1000000,1200000,2500000]:
        print(n, fr(n))
