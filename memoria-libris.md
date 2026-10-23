# Memória do projeto Libris

## Visão geral

Este projeto inclui:
- Cloud Functions do Firebase para backup semanal
- envio manual de avisos pelo aplicativo desktop via SMTP
- regras de segurança mais rígidas no Firestore
- painel admin com configurações da escola
- reset do ciclo de avisos em renovações de empréstimo

## 1) Envio manual de e-mails por SMTP

Os avisos ao leitor e à coordenação são enviados manualmente no aplicativo desktop. Não há disparos agendados em nuvem.

- Host, porta e usuário SMTP ficam na configuração local da escola, sempre associados ao `schoolId`.
- A senha de aplicativo é guardada no cofre de credenciais do sistema operacional pelo comando Tauri, e não no IndexedDB, Firestore ou backup.
- São aceitas conexões seguras nas portas 465 (TLS) e 587 (STARTTLS obrigatório).
- O aplicativo registra os últimos 100 envios por escola em `email_logs`, com destinatário, assunto, data e status. O corpo e as credenciais não são registrados.
- O arquivo de backup inclui o histórico de envios, mas não exporta a senha SMTP.

## 4) Reset ao renovar empréstimo

Um ponto crítico da funcionalidade era reiniciar o ciclo de avisos quando o empréstimo era renovado.

Por isso, ao chamar a renovação, o frontend passou a atualizar:

```js
notices: {}
```

Isso garante que:
- o sistema não reuse avisos já enviados
- o ciclo comece do zero para o novo prazo
- o aluno não receba lembretes antigos após renovação

## 5) Configurações da escola

No painel administrativo, foi incluída a aba "Configurações".

### Campos adicionados
- `coordinationEmail`
- `reminderDays`
- `coordinationDays`

Esses valores são salvos no documento da escola, por exemplo em:

```js
schools/escola-padrao
```

## 6) Regras do Firestore

O arquivo `firestore.rules` foi reforçado para evitar brechas de segurança.

### Principais melhorias
- somente usuários autenticados entram no fluxo
- somente admins podem criar/alterar dados sensíveis
- verificação de estoque e totais dos livros
- regras mais restritas para `schools`
- `loans` só aceitam atualizações esperadas
- `notices` não pode ser alterado livremente pelo frontend

## 7) Painel admin

A interface foi ajustada para permitir que o admin configure a escola e o comportamento dos lembretes sem mexer em código.

Isso reduz dependência de manutenção manual e melhora a experiência de operação do sistema escolar.

## 8) O comportamento dos avisos

O usuário abre a notificação de um empréstimo e escolhe enviar um e-mail manual ao leitor ou à coordenação. Os avisos por WhatsApp continuam disponíveis. Os envios automáticos foram desativados porque as credenciais SMTP pertencem ao computador local da escola.

## 9) Resultado

O projeto passou a ter:
- envio SMTP manual sem serviço de terceiros
- regras de segurança mais robustas
- manutenção mais simples
- ajustes de negócio configuráveis pela escola
- auditoria local dos e-mails enviados

Este arquivo serve como documentação interna do funcionamento atual do projeto.
