# Sécurité

KeyWatcher ne demande, ne récupère et n’enregistre jamais les valeurs des clés API Microsoft Foundry.

- Le jeton Microsoft est conservé dans `sessionStorage` et disparaît avec la session de l’onglet.
- Le Client ID, le Tenant ID, les noms de projets et les budgets locaux sont conservés dans `localStorage`.
- Aucun serveur tiers, service d’analyse ou CDN n’est appelé.
- Toutes les requêtes distantes vont directement vers `login.microsoftonline.com` ou `management.azure.com`.
- L’export des projets ne contient ni jeton Microsoft, ni valeur de clé API.

Pour signaler un problème de sécurité, ouvrez une alerte de sécurité privée sur le dépôt GitHub plutôt qu’une issue publique.
