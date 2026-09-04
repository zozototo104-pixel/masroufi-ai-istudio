const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  /\* إذا لم يذكر من أين دفع، \*\*اسأله فوراً\*\*: "هل سددت الدين نقداً \(كاش\) أم من محفظة PalPay\؟"/g,
  "* **إياك إطلاقاً** أن تسجل سداد الدين كمصروف (add_transaction - expense). سداد الدين ليس مصروفاً جديداً! يجب استخدام pay_debt فقط.\n  * إذا لم يذكر من أين دفع، **اسأله فوراً**: \"هل سددت الدين نقداً (كاش) أم من محفظة PalPay؟\""
);

fs.writeFileSync('server.ts', code);
