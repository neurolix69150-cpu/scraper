# 🕷️ WebCrawlr v2 — Dashboard de Scraping Pro

Dashboard complet et performant pour scraper des sites web gratuitement sur votre VPS.

## ✨ Fonctionnalités v2

### 🔀 Proxy Rotatif
- Pool de proxies avec rotation automatique (round-robin)
- Support HTTP, HTTPS, SOCKS5
- Désactivation automatique des proxies morts (5 erreurs)
- Test de proxy avec vérification IP sortante

### ⏰ Scheduler Cron
- Scrapes automatiques planifiés (expressions cron)
- Presets : 30min, 1h, 6h, quotidien, hebdomadaire, mensuel
- Pause/reprise, compteur de runs

### 🔔 Notifications
- Email SMTP (Gmail, SendGrid, Mailgun...)
- Webhook (Discord, Slack, Make, Zapier, n8n)
- Email HTML stylisé + payload JSON pour webhooks

### 📗 Google Sheets
- Export direct via Service Account
- Création automatique d'onglets

---

## 🚀 Installation VPS (Docker)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
scp -r scraper-dashboard user@VOTRE_IP:/home/user/
ssh user@VOTRE_IP
cd scraper-dashboard
docker-compose up -d --build
# → http://VOTRE_IP:80
```

## Gmail SMTP
- Host: smtp.gmail.com | Port: 587
- Utilisez un App Password (myaccount.google.com/apppasswords)

## Google Sheets
1. console.cloud.google.com → API Google Sheets → Service Account → Télécharger JSON
2. Partager votre Sheet avec l'email du compte de service
3. Coller le JSON dans WebCrawlr → Google Sheets
