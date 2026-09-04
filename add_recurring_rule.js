import fs from 'fs';
let content = fs.readFileSync('firestore.rules', 'utf8');

const replacement = `
    match /recurring_items/{itemId} {
      allow read, write: if isSignedIn() && isValidId(itemId);
    }
    match /users/{userId} {
`;
content = content.replace("match /users/{userId} {", replacement);

fs.writeFileSync('firestore.rules', content);
