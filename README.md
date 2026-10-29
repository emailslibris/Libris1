# Libris 1.2.2

Sistema escolar de biblioteca da CREDE, feito com HTML, CSS e JavaScript. Os dados operacionais ficam no IndexedDB da máquina da biblioteca.

## Estado da arquitetura

O painel usa IndexedDB para guardar livros, leitores, empréstimos, contas locais, configurações e auditoria. Os dados operacionais ficam no computador da escola. O Firebase Authentication é usado somente para o acesso restrito da CREDE. Os backups são gerados localmente como arquivos ZIP.

## Acesso local

- A CREDE abre **Configuração local (CREDE)**, cadastra a escola e cria os emails e senhas dos usuários. Senhas são armazenadas como hashes PBKDF2 com salt, não em texto puro.
- Os usuários entram pela única tela normal de login. Não há criação nem redefinição de senha pelo usuário; a CREDE altera as credenciais na configuração local.
- O login do painel não usa conta Google.
- A sessão permanece salva neste computador até a pessoa sair. Limpar os dados do navegador/aplicativo encerra a sessão e exige restaurar um backup.
- O botão **Importar** aceita um CSV legado de livros ou um ZIP completo de backup com arquivos CSV. Categorias ausentes do CSV legado são criadas usando o prefixo do código do livro; a escola de origem é remapeada para a escola configurada.
- O botão **Exportar** gera um backup completo ZIP com CSVs para salvar no computador. Para restaurar, use **Importar** e selecione o ZIP. Os CSVs não incluem senhas nem hashes de senha; a restauração mantém as contas locais já cadastradas no computador. Guarde uma cópia do ZIP em um local seguro.
- A senha SMTP fica no cofre de credenciais do sistema operacional, separada do IndexedDB e dos backups. Os últimos 100 e-mails enviados por escola são auditados localmente, sem armazenar o corpo da mensagem.

Mantenha cópias dos arquivos antigos até confirmar a importação do CSV e testar a restauração do backup completo.

## Configuração Firebase

1. No Firebase Console do projeto `librisce`, habilite **Authentication > Email/Password** para as contas administrativas CREDE. Adicione o domínio HTTPS publicado em **Authorized domains**.
2. Em **Authentication > Users**, cadastre cada email administrativo CREDE com sua própria senha forte. O acesso usa o email e a senha informados na tela **Configuração local (CREDE)**; as credenciais são validadas pelo Firebase Authentication e não ficam no código.
3. No computador da biblioteca, use **Configuração local (CREDE)** e entre com um dos emails administrativos cadastrados no Firebase e sua senha correspondente. Cadastre somente contas autorizadas para administrar a configuração local.
4. Cadastre a escola, o email da coordenação, as contas locais e as configurações SMTP institucionais. A senha de app é salva no cofre seguro do sistema no aplicativo desktop.

As contas locais da escola são independentes do Firebase Authentication; a senha administrativa CREDE continua sendo gerenciada pelo Firebase.

## Migração de dados legados

Para trazer o acervo do site antigo, selecione o CSV em **Importar**. Os nomes de categorias do arquivo são preservados e categorias que ainda não existem são cadastradas automaticamente com base no prefixo do código. IDs de escola antigos, como `escola_1`, são tratados como origem e substituídos pelo identificador local configurado. Para restaurar um backup Libris completo, selecione o ZIP gerado em **Exportar**. A restauração substitui os dados locais da escola atual.

## Capas, sinopses e avisos por e-mail

Ao cadastrar um livro, o sistema busca automaticamente capa e descrição pelo título, autor e editora. A primeira fonte é o Google Books; se não houver resultado, ele tenta a Open Library. Se nenhuma fonte encontrar o livro, o cadastro continua normalmente sem esses dados.

Os avisos de e-mail são enviados manualmente pelo aplicativo desktop através do servidor SMTP configurado pela CREDE. **Avisar leitor por e-mail** envia ao endereço cadastrado; **Avisar coordenação** envia à coordenação escolar. O envio exige conexão com o servidor de e-mail e aceita portas seguras 465 (TLS) ou 587 (STARTTLS). Não há cota mensal nem envio automático em segundo plano. Os últimos 100 envios de cada escola são registrados localmente.

## Executar localmente

Gere os arquivos publicados e sirva a pasta `dist` por HTTP:

```sh
npm run build:hosting
python3 -m http.server 8080 --directory dist
```

Abra `http://localhost:8080` no Chromium. Não abra o HTML diretamente pelo gerenciador de arquivos: módulos JavaScript e o service worker precisam de um servidor HTTP. Os dados da biblioteca são locais; conexão é necessária para login CREDE e para enviar e-mails pelo SMTP institucional no desktop.

## Aplicativo desktop Tauri

O desktop usa Tauri v2 e mantém a mesma interface web. A versão atual é 1.2.2. Para desenvolvimento, instale as dependências Linux do Tauri e execute `npm run tauri dev`. Para gerar o pacote Debian da versão atual, execute `npm run build:desktop`; o arquivo será criado em `src-tauri/target/release/bundle/deb/` e arquivado em `versoes/1.2.2/`.

No Ubuntu, o build requer Rust/Cargo e os pacotes `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libdbus-1-dev`, `libxdo-dev`, `librsvg2-dev` e `libwebkit2gtk-4.1-dev`. O serviço de credenciais do sistema (Secret Service) deve estar disponível para guardar a senha SMTP. O login CREDE, o acesso à câmera e o envio SMTP devem ser validados no WebView do sistema após a instalação.

Para ler o QR code da etiqueta, clique em **Usar câmera** e permita o acesso quando solicitado. O QR contém a escola, o identificador e o código do livro; o app procura o registro entre os livros já carregados para a escola atual. Se o acesso à câmera estiver bloqueado, feche outros programas que possam estar usando-a e confira as permissões do navegador ou do sistema.

O **leitor 2D USB** funciona como teclado: clique no campo **ID do livro** e escaneie o código de barras ou QR; o aparelho deve enviar Enter ao final da leitura. Não é preciso ativar o leitor no Libris, e a câmera continua disponível pelo botão **Usar câmera**. A etiqueta Libris contém o QR com dados e o código do acervo impresso, então leitores 2D podem preencher o campo diretamente. Também é possível digitar o código, como `LI-0002`, e pressionar Enter.

## Instalar no Chromium/Xubuntu

1. Abra a URL HTTPS publicada ou `http://localhost:8080` no Chromium.
2. Use o ícone **Instalar Libris** na barra de endereço ou abra o menu do Chromium e escolha **Instalar Libris**.
3. Confirme a instalação. O Libris será aberto em uma janela própria e aparecerá no lançador de aplicativos.

Se a opção de instalação não aparecer, confira se o manifest, os ícones e o service worker estão acessíveis na mesma origem. Para instalação em outro computador ou celular, a origem precisa usar HTTPS; a exceção para HTTP vale somente para `localhost`.

## Publicar

Para publicar o shell estático fora do Firebase, use Cloudflare Pages conectado ao repositório:

1. Crie um projeto Pages e conecte este repositório.
2. Configure o comando de build como `npm run build:hosting` e o diretório de saída como `dist`.
3. Aguarde a URL HTTPS e teste o login e as funções do app antes de compartilhar o endereço.

Cadastre o domínio HTTPS definitivo em **Authorized domains** no Firebase Authentication. Nunca coloque Client Secret, chave privada ou token de serviço no frontend.

O build copia doze arquivos necessários ao app: HTML, CSS, JavaScript, módulos de armazenamento local, configuração de autenticação, imagem de marca, manifest, service worker e dois ícones. Scripts de migração, funções de servidor, chaves privadas e arquivos de desenvolvimento não são publicados.

## Limites atuais

- A autenticação CREDE ainda depende do Firebase Authentication por email/senha; o provedor Google é usado somente para autorização do Drive. Não há Client Secret no frontend.
- A migração de dados existentes requer o arquivo de backup legado. O app não conecta ao Firestore.
- A função agendada de backup no Drive, em `functions/`, consulta somente dados legados do Firestore; ela não inclui os dados atuais do IndexedDB local. Para proteger os dados atuais, gere o ZIP pelo aplicativo e teste a restauração periodicamente.
- A validação automatizada cobre armazenamento e CSV. O login administrativo ainda precisa ser testado com a configuração Firebase do ambiente de produção.
