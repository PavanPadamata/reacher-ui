# Password Reset Instructions

## Option A — Reset Password (you remember your email)

**Step 1** — SSH into your VPS:
```bash
ssh root@YOUR_VPS_IP
```

**Step 2** — Generate a bcrypt hash of your new password:
```bash
docker exec -it reacher-ui node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('YOUR_NEW_PASSWORD', 12).then(h => console.log(h));
"
```
Copy the output hash.

**Step 3** — Open the database:
```bash
docker exec -it reacher-db psql -U reacher -d reacher
```

**Step 4** — Update your password:
```sql
UPDATE "Admin" SET password = 'PASTE_HASH_HERE' WHERE email = 'your@email.com';
\q
```

**Step 5** — Open the app and log in with your new password.

---

## Option B — Full Reset (forgot email or password)

This deletes the admin account. The app will redirect to `/setup` so you can create a fresh one. **Your jobs and verification data are NOT deleted.**

**Step 1** — SSH into your VPS:
```bash
ssh root@YOUR_VPS_IP
```

**Step 2** — Delete the admin record:
```bash
docker exec -it reacher-db psql -U reacher -d reacher -c 'DELETE FROM "Admin";'
```

**Step 3** — Open the app in your browser:
```
http://YOUR_VPS_IP:3000
```
You will be automatically redirected to `/setup`.

**Step 4** — Create a new admin email and password.

---

## Notes

- Passwords are hashed with bcrypt (one-way) — no one can recover your original password from the database.
- Sessions expire after **7 days** — you will be asked to log in again after that.
- If you change `AUTH_SECRET` in `docker-compose.yml`, all existing sessions are invalidated and everyone must log in again.
