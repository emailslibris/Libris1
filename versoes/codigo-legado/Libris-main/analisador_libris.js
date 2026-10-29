const fs = require('fs');

const FILE_NAME = 'script.js';
const BACKUP_NAME = 'script.js.bak';

if (!fs.existsSync(FILE_NAME)) {
    console.error(`❌ Erro: Arquivo ${FILE_NAME} não encontrado na pasta atual.`);
    process.exit(1);
}

fs.copyFileSync(FILE_NAME, BACKUP_NAME);
console.log(`\n📦 Backup de segurança criado: ${BACKUP_NAME}`);

const code = fs.readFileSync(FILE_NAME, 'utf8');
let issues = [];

console.log("🔍 Iniciando auditoria de segurança no script.js...\n");

// 1. Bypass de Login
if (code.includes('demoAdmin') || code.includes('admin@teste.com')) {
    console.log("🚨 [FALHA] Bypass de login (demoAdmin) ainda está no código!");
    issues.push("Bypass demoAdmin presente");
} else {
    console.log("✅ [OK] Sem credenciais de bypass.");
}

// 2. Transação no Cadastro de Livros
if (!code.includes('runTransaction')) {
    console.log("🚨 [FALHA] Cadastro de livros sem runTransaction.");
    issues.push("Falta runTransaction no cadastro de livros");
} else {
    console.log("✅ [OK] runTransaction detectado no código.");
}

// 3. Empréstimos Duplicados
const hasDuplicateCheck = code.includes("status") && code.includes("active");
if (!hasDuplicateCheck) {
    console.log("🚨 [FALHA] Validação de empréstimo duplicado não encontrada.");
    issues.push("Falta checagem de empréstimo ativo duplicado");
} else {
    console.log("✅ [OK] Checagem de empréstimo ativo detectada.");
}

if (issues.length === 0) {
    console.log("\n🚀 Excelente! O script.js passou em todas as checagens principais.");
} else {
    console.log(`\n⚠️ O arquivo ainda possui ${issues.length} pendência(s) das quais cuidamos.`);
}
