// Subset matcher shared by the eval scripts.
// expected object  -> every expected key must match in actual (extra keys in actual are fine)
// expected array   -> same length, element-wise subset match
// {"$startsWith": "x"} string prefix, {"$contains": {...}} some array element matches
// "$any" matches anything, "$num" any number, {"$length": n} an array of length n
export function match(expected, actual, path = '$') {
  if (expected === '$any') return [];
  if (expected === '$num') return typeof actual === 'number' ? [] : [`${path}: expected a number, got ${JSON.stringify(actual)}`];
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$length' in expected) {
    return Array.isArray(actual) && actual.length === expected.$length ? [] : [`${path}: expected array of length ${expected.$length}, got ${Array.isArray(actual) ? actual.length : JSON.stringify(actual)}`];
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$startsWith' in expected) {
    return typeof actual === 'string' && actual.startsWith(expected.$startsWith) ? [] : [`${path}: expected a string starting with ${JSON.stringify(expected.$startsWith)}, got ${JSON.stringify(actual)}`];
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$contains' in expected) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${JSON.stringify(actual)}`];
    return actual.some((a) => match(expected.$contains, a, path).length === 0) ? [] : [`${path}: no array element matches ${JSON.stringify(expected.$contains)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${JSON.stringify(actual)}`];
    if (actual.length !== expected.length) return [`${path}: expected ${expected.length} item(s), got ${actual.length}`];
    return expected.flatMap((e, i) => match(e, actual[i], `${path}[${i}]`));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    return Object.keys(expected).flatMap((k) => (k in actual ? match(expected[k], actual[k], `${path}.${k}`) : [`${path}.${k}: missing`]));
  }
  return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

export function checkCase(c, res) {
  const problems = [];
  if (res.status !== c.expect.status) problems.push(`status: expected ${c.expect.status}, got ${res.status}`);
  if (c.expect.body !== undefined) problems.push(...match(c.expect.body, res.body));
  return problems;
}

// Returns {pass, fail, intentionalConfirmed, unexpected}; prints a table.
export function report(label, cases, resultsById) {
  let pass = 0, fail = 0, intentional = 0, unexpectedPass = 0;
  for (const c of cases) {
    const res = resultsById.get(c.id);
    const problems = res ? checkCase(c, res) : ['no result recorded'];
    const ok = problems.length === 0;
    if (c.intentionalFail) {
      if (ok) { unexpectedPass++; console.log(`  UNEXPECTED PASS  ${c.id}  ${c.title}`); }
      else { intentional++; console.log(`  FAIL (intentional, as designed)  ${c.id}\n      ${problems.join('\n      ')}`); }
    } else if (ok) { pass++; console.log(`  PASS  ${c.id}  ${c.title}`); }
    else { fail++; console.log(`  FAIL  ${c.id}  ${c.title}\n      ${problems.join('\n      ')}`); }
  }
  console.log(`\n${label}: ${pass} passed, ${fail} failed, ${intentional} intentional failure(s) confirmed, ${unexpectedPass} intentional case(s) unexpectedly passed`);
  return { pass, fail, intentional, unexpectedPass };
}
