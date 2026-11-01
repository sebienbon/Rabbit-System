# Rabbit-System

Interface de réception hors ligne de Rabbit Tree. Le staff travaille dans cette interface ; le Google Sheet reste la base de référence et le staff n'y a plus accès.

- **Interface** : les fichiers à la racine (`index.html`, `js/`, …), servis par GitHub Pages. Elle garde tout dans le navigateur et envoie les opérations au Sheet en arrière-plan, même après une coupure Internet de plusieurs heures.
- **Serveur** : `dev/server/30.UI_api.gs`, à coller dans le projet Apps Script lié au Sheet, publié en application web (exécuter en tant que : moi, accès : tout le monde).
- **Tests** : dans `dev/`, `npm i` puis `node --test tests/server.test.js` (serveur sur un faux Sheet) et `node tests/e2e.js` (Chrome, avec coupure simulée).

## Mise en place sur un Sheet
1. Dans Apps Script, lancer `UI_setup` une fois (crée UI_Users, UI_Log, UI_Shifts).
2. Dans UI_Users, une ligne par personne : identifiant, nom affiché, rôle (staff / manager / admin), adresse Gmail utilisée dans les colonnes Author, et un mot de passe dans « Set new password here » (chiffré puis effacé à la première connexion).
3. Déployer > Nouveau déploiement > Application web. Mettre l'URL `/exec` dans `js/config.js`.
4. Sur l'ordinateur de réception, se connecter une fois avec un compte manager en cochant « Make this the reception computer ».

## Publier une mise à jour
Changer `VERSION` dans `sw.js`. L'ordinateur de réception se recharge tout seul dès que personne n'est en train de saisir.

Actuellement branché sur la **copie de test** du Sheet.
