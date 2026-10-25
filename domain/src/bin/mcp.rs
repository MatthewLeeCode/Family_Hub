use clap::Parser;
use family_domain::mcp::NotesMcp;
use rmcp::ServiceExt;
#[derive(Parser)]
struct Args {
    #[arg(long)]
    port: u16,
    #[arg(long)]
    binding: String,
    #[arg(long)]
    subject: String,
    #[arg(long)]
    space: String,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let adapter = NotesMcp::connect(
        args.port,
        args.binding,
        args.subject,
        args.space,
        std::path::Path::new("family-domain.credential"),
    )
    .await?;
    adapter
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}
