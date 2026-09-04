const fs = require('fs');
let code = fs.readFileSync('src/server/tools.ts', 'utf8');

const matchStr = \`  if (
    textToCheck.includes('دفع دين') || 
    textToCheck.includes('دفعت دين') || 
    (type === 'expense' && category.includes('سداد')) || 
    ((textToCheck.includes('سداد') || textToCheck.includes('سدد') || textToCheck.includes('تسديد')) && (textToCheck.includes('دين') || textToCheck.includes('الديون') || textToCheck.includes('لشخص') || textToCheck.includes('لصديق'))) ||
    (account === 'debt' && type === 'expense' && (textToCheck.includes('سداد') || textToCheck.includes('تسديد') || textToCheck.includes('سدد') || textToCheck.includes('دفع') || category.includes('سداد')))
  ) {
    let fromAcc = normalizeAccount(args.paymentMethod || args.fromAccount || 'cash');
    if (fromAcc === 'debt') fromAcc = 'cash'; 
    return await payDebt({ amount, paymentMethod: fromAcc, creditor: args.merchant || args.subcategory || 'سداد دين', notes: args.notes }, userId, token);
  }

  if ((textToCheck.includes('تحويل') && (textToCheck.includes('من') || textToCheck.includes('إلى') || textToCheck.includes('لبال') || textToCheck.includes('كاش'))) || args.category === 'تحويل' || args.category === 'تحويل داخلي') {
    const fromAcc = normalizeAccount(args.fromAccount || args.account || (textToCheck.includes('من بال') ? 'palPay' : 'cash'));
    const toAcc = normalizeAccount(args.toAccount || (textToCheck.includes('إلى بال') || textToCheck.includes('لبال') ? 'palPay' : 'cash'));
    return await transferMoney({ amount, fromAccount: fromAcc, toAccount: toAcc, notes: args.notes }, userId, token);
  }

  let type = String(args.type || 'expense').toLowerCase();
  if (type.includes('صرف') || type.includes('مصروف') || type.includes('دفع') || type.includes('شراء')) type = 'expense';
  if (type.includes('دخل') || type.includes('قبض') || type.includes('راتب') || type.includes('إيداع') || type.includes('ايداع') || type.includes('مرحل') || type.includes('تحويل لي') || type.includes('income')) type = 'income';
  if (type !== 'income' && type !== 'expense') type = 'expense';

  let account = normalizeAccount(args.paymentMethod || args.account || (String(args.notes || '').includes('دين') ? 'debt' : 'cash'));
  const category = String(args.category || 'غير مصنف');\`;

const replaceStr = \`  let type = String(args.type || 'expense').toLowerCase();
  if (type.includes('صرف') || type.includes('مصروف') || type.includes('دفع') || type.includes('شراء')) type = 'expense';
  if (type.includes('دخل') || type.includes('قبض') || type.includes('راتب') || type.includes('إيداع') || type.includes('ايداع') || type.includes('مرحل') || type.includes('تحويل لي') || type.includes('income')) type = 'income';
  if (type !== 'income' && type !== 'expense') type = 'expense';

  let account = normalizeAccount(args.paymentMethod || args.account || (String(args.notes || '').includes('دين') ? 'debt' : 'cash'));
  const category = String(args.category || 'غير مصنف');

  if (
    textToCheck.includes('دفع دين') || 
    textToCheck.includes('دفعت دين') || 
    (type === 'expense' && category.includes('سداد')) || 
    ((textToCheck.includes('سداد') || textToCheck.includes('سدد') || textToCheck.includes('تسديد')) && (textToCheck.includes('دين') || textToCheck.includes('الديون') || textToCheck.includes('لشخص') || textToCheck.includes('لصديق'))) ||
    (account === 'debt' && type === 'expense' && (textToCheck.includes('سداد') || textToCheck.includes('تسديد') || textToCheck.includes('سدد') || textToCheck.includes('دفع') || category.includes('سداد')))
  ) {
    let fromAcc = normalizeAccount(args.paymentMethod || args.fromAccount || 'cash');
    if (fromAcc === 'debt') fromAcc = 'cash'; 
    return await payDebt({ amount, paymentMethod: fromAcc, creditor: args.merchant || args.subcategory || 'سداد دين', notes: args.notes }, userId, token);
  }

  if ((textToCheck.includes('تحويل') && (textToCheck.includes('من') || textToCheck.includes('إلى') || textToCheck.includes('لبال') || textToCheck.includes('كاش'))) || args.category === 'تحويل' || args.category === 'تحويل داخلي') {
    const fromAcc = normalizeAccount(args.fromAccount || args.account || (textToCheck.includes('من بال') ? 'palPay' : 'cash'));
    const toAcc = normalizeAccount(args.toAccount || (textToCheck.includes('إلى بال') || textToCheck.includes('لبال') ? 'palPay' : 'cash'));
    return await transferMoney({ amount, fromAccount: fromAcc, toAccount: toAcc, notes: args.notes }, userId, token);
  }\`;

code = code.replace(matchStr, replaceStr);
fs.writeFileSync('src/server/tools.ts', code);
