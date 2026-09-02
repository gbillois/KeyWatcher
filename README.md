# KeyWatcher

KeyWatcher est un tableau de bord local, statique et sans dépendance pour consulter simplement les ressources Microsoft Foundry / Azure OpenAI, leurs coûts mensuels, leurs budgets et leur consommation de jetons par modèle.

L’interface reprend la direction visuelle de CrisisMaker : bleu profond, turquoise, vert, cartes claires et navigation compacte.

## Fonctionnalités

- connexion Microsoft avec OAuth 2.0 Authorization Code + PKCE ;
- découverte des ressources Azure AI actives dans les abonnements accessibles ;
- coût réel du mois depuis Azure Cost Management ;
- budget Azure associé par filtre `ResourceId`, avec budget local de remplacement ;
- seuil orange à partir de 75 % et rouge à partir de 95 % ;
- histogramme des jetons par modèle, sur la journée ou le mois ;
- nom de projet et budget local enregistrés dans le navigateur ;
- tri sur chaque colonne et recherche ;
- export/import JSON des projets ;
- export CSV ou JSON des consommations ;
- aucune valeur de clé API récupérée, affichée ou stockée.

## Lancer KeyWatcher

Double-cliquez sur `start.command`, ou lancez :

```sh
./start.command
```

KeyWatcher s’ouvre sur <http://localhost:8080/>. Le serveur utilisé est celui inclus avec Python 3 ; aucune installation npm ou pip n’est nécessaire.

Une ouverture directe de `index.html` en `file://` permet de voir l’interface, mais l’authentification Microsoft exige l’adresse HTTP locale.

## Préparer l’authentification Microsoft

Une page locale ne peut pas réutiliser directement les cookies du portail Azure. Le navigateur réutilisera votre session Microsoft existante, mais Microsoft exige d’abord un identifiant d’application publique.

1. Ouvrez **Microsoft Entra ID → App registrations → New registration**.
2. Donnez-lui le nom `KeyWatcher` et conservez le type de comptes correspondant à votre organisation.
3. Dans **Authentication**, ajoutez la plateforme **Single-page application (SPA)**.
4. Ajoutez exactement l’URI `http://localhost:8080/`.
5. Dans **API permissions**, ajoutez **Azure Service Management → Delegated permissions → user_impersonation**.
6. Copiez l’**Application (client) ID**.
7. Dans KeyWatcher, ouvrez les réglages et renseignez ce Client ID. Le Tenant ID peut rester sur `organizations` ou être remplacé par l’identifiant de votre locataire.

Ne créez pas de secret client : une application exécutée dans le navigateur ne peut pas garder un secret.

Documentation Microsoft :

- [Authorization Code Flow avec PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Configurer une URI de redirection SPA](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)

## Droits Azure nécessaires

Le compte connecté doit avoir accès aux abonnements concernés :

- `Reader` pour découvrir les ressources ;
- accès en lecture aux métriques Azure Monitor ;
- `Cost Management Reader` pour consulter les coûts et budgets.

KeyWatcher ne demande aucun droit de création, de modification ou de suppression sur les ressources Azure.

## Ce qu’une « clé » représente

Azure fournit généralement deux valeurs de clé interchangeables par ressource Cognitive Services / Foundry. Azure Monitor et Cost Management n’attribuent pas les consommations séparément à chacune de ces deux valeurs.

KeyWatcher représente donc une ligne par **ressource Azure AI active**, sans appeler l’opération sensible `listKeys`. Pour isoler plusieurs projets, utilisez une ressource ou un déploiement distinct par projet, ou donnez simplement un nom local à chaque ressource dans KeyWatcher.

## Budgets et fraîcheur des données

- Un budget Azure filtré exactement sur le `ResourceId` est repris automatiquement.
- Un montant saisi dans la colonne Budget prend priorité et reste local au navigateur.
- Les données Cost Management peuvent arriver avec plusieurs heures de retard.
- Les budgets Azure alertent mais ne coupent pas les appels.
- Les métriques de jetons arrivent généralement plus vite, mais leur disponibilité dépend du type de ressource et de déploiement.

## Stockage et exports

- `localStorage` : Tenant ID, Client ID, abonnements choisis, noms de projets et budgets locaux.
- `sessionStorage` : jeton Microsoft temporaire, jamais exporté.
- JSON projets : métadonnées projet uniquement.
- CSV/JSON consommations : dernier relevé mensuel et série de jetons actuellement affichée.

La politique de sécurité complète se trouve dans [SECURITY.md](SECURITY.md).

## Tests

Les tests utilisent uniquement le moteur de test fourni par Node.js :

```sh
npm test
```

Aucune dépendance n’est téléchargée.
