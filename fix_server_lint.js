import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  "responseData = await handler(call.args || {}, req.user.uid, token);",
  "const authToken = req.headers.authorization.split('Bearer ')[1];\n                responseData = await handler(call.args || {}, req.user.uid, authToken);"
);

// fakeDb error
code = code.replace(
  "const res = await fetch(`${baseUrl}/${this.collection}/${encodeURIComponent(this.id)}?key=${apiKey}`, {",
  "const res = await fetch(`${baseUrl}/${this.name}?key=${apiKey}`, {"
); // wait, for add it's just this.name? No, add is doc() which returns a FakeDoc. FakeCollection doesn't have an id!

fs.writeFileSync('server.ts', code);
