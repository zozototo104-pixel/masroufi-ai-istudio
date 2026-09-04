import fs from 'fs';
let content = fs.readFileSync('firestore.rules', 'utf8');

const replacement = `
    match /users/{userId}/memory/{memoryId} {
      allow read, write: if isOwner(userId) && isValidId(userId);
    }
    match /users/{userId} {
`;
content = content.replace("match /users/{userId} {", replacement);

fs.writeFileSync('firestore.rules', content);
