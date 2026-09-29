# Valigia Implantare

Web app per gestire gli impianti dentali in valigia (Bologna, Faenza, Rimini): scorte per marca e misura, prenotazioni per paziente, registro degli impianti eseguiti. Si installa sull'iPhone da Safari con "Aggiungi alla schermata Home".

- **Sito**: file statici pubblicati con GitHub Pages (`index.html`, `config.js`, `manifest.webmanifest`, `icons/`).
- **Dati e accessi**: Supabase (database Postgres in tempo reale + login con email e password).

## Configurazione di Supabase (una volta sola)

1. Su [supabase.com](https://supabase.com) entra con **Continue with GitHub** e crea un progetto nella regione **Central EU (Frankfurt)**.
2. **SQL Editor → New query**: incolla il contenuto di `supabase/schema.sql` e premi **Run**. Crea le tabelle, le regole di accesso e carica i dati iniziali.
3. **Authentication → Sign In / Providers → Email**: disattiva **Confirm email** e salva. (Senza server di posta, Supabase non può inviare le email di conferma.)
4. **Project Settings → API**: copia **Project URL** e la chiave **anon public** in `config.js`.

## Accessi

Entra solo chi ha l'email nella tabella `accessi`. Il primo indirizzo è inserito da `schema.sql`; gli altri si aggiungono dall'app in **Elenchi → Accessi**. Al primo accesso ognuno tocca **Primo accesso? Crea la tua password**.

Password dimenticata: in Supabase, **Authentication → Users**, elimina l'utente; la persona poi ricrea la password con "Primo accesso".

## Sviluppo locale

```bash
python3 -m http.server 8080
```
