using System.ComponentModel;
using AdventureWorks.Services;
using ModelContextProtocol.Server;

namespace AdventureWorks.Tools;

/// <summary>
/// MCP tools exposing the virtual bank simulator APIs.
/// The bank tracks multi-currency balances for the AdventureWorks simulation.
/// USD is the primary account and is seeded with total historical profit on first use.
/// Foreign-currency sales create balances in those currencies; vendor payments always use USD.
/// </summary>
[McpServerToolType]
public class BankMcpTools
{
    private readonly BankService _bank;

    public BankMcpTools(BankService bank)
    {
        _bank            = bank;
    }

    // ── Status ────────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get the current virtual bank status: all currency account balances and a USD-equivalent total calculated using live exchange rates. The USD account is seeded from total historical AdventureWorks profit on first use. Use this to understand the current financial position of the simulation.")]
    public async Task<string> GetBankStatus()
    {
        return await _bank.GetBankStatusAsync();
    }

    // ── Specific account ──────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get the current balance for a specific currency account. For example, 'USD' for the main account or 'EUR' for the Euro account. Returns the balance in that currency's denomination.")]
    public async Task<string> GetBankAccount(
        [Description("ISO 4217 currency code (e.g. USD, EUR, GBP, CAD). Case insensitive.")] string currencyCode)
    {
        return await _bank.GetAccountAsync(currencyCode);
    }

    // ── Transactions ──────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("List the most recent bank transactions across all currencies or filtered to a specific currency. Each entry shows the currency, amount (positive=credit, negative=debit), running balance after the transaction, transaction type, description, and timestamp. Use this to audit the simulation's financial history.")]
    public async Task<string> GetBankTransactions(
        [Description("Optional ISO 4217 currency code to filter transactions (e.g. EUR). Leave empty or null to see all currencies.")] string? currencyCode = null,
        [Description("Maximum number of transactions to return (1–200). Defaults to 20.")] int maxCount = 20)
    {
        return await _bank.GetTransactionsAsync(currencyCode, maxCount);
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Record a credit (incoming money) to a virtual bank account. Use this when a customer sale is completed, a return is received, or any other money-in event occurs. Foreign currency sales (e.g. a EUR sale) should use the appropriate currency code so that a Euro balance is maintained separately. The amount must be positive.")]
    public async Task<string> BankDeposit(
        [Description("ISO 4217 currency code for the account to credit (e.g. USD, EUR, GBP).")] string currencyCode,
        [Description("Positive amount to deposit in the specified currency.")] decimal amount,
        [Description("Human-readable description of why the deposit is being made (e.g. 'Customer sale SO-12345').")] string description,
        [Description("Optional reference ID linking to the originating event (e.g. sales order number, invoice ID).")] string? referenceId = null,
        [Description("Transaction type for categorisation. Use 'sale' for customer revenue, 'other' for miscellaneous credits.")] string transactionType = "sale")
    {
        return await _bank.DepositAsync(currencyCode, amount, description, referenceId, transactionType);
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("Record a debit (outgoing money) from a virtual bank account. Use this when paying vendors for purchased components (always use USD), paying worker wages (USD), or any other money-out event. Negative balances are permitted. The amount must be positive — it will be debited automatically.")]
    public async Task<string> BankWithdraw(
        [Description("ISO 4217 currency code for the account to debit. Vendor payments and payroll must use USD.")] string currencyCode,
        [Description("Positive amount to debit from the specified currency account.")] decimal amount,
        [Description("Human-readable description of the payment (e.g. 'Vendor payment PO-789' or 'Payroll week 2026-04-14').")] string description,
        [Description("Optional reference ID linking to the originating event (e.g. purchase order number, payroll run ID).")] string? referenceId = null,
        [Description("Transaction type for reporting. Use 'purchase' for vendor payments, 'payroll' for worker wages, 'other' for miscellaneous debits.")] string transactionType = "purchase")
    {
        return await _bank.WithdrawAsync(currencyCode, amount, description, referenceId, transactionType);
    }

    // ── Currencies ────────────────────────────────────────────────────────────

    [McpServerTool]
    [Description("List all currencies supported by this virtual bank. Currency accounts are automatically created for every currency in the AdventureWorks Sales.Currency database table. New transactions in any of these currencies are accepted.")]
    public async Task<string> GetSupportedCurrencies()
    {
        return await _bank.GetCurrenciesAsync();
    }

    // ── Financial reporting ───────────────────────────────────────────────────

    [McpServerTool]
    [Description("Get a financial summary across all simulators showing procurement spend (PO approvals and refunds), manufacturing WO overhead costs, payroll charges per routing operation, and scrap write-offs. Provides totals and transaction counts for each category.")]
    public async Task<string> GetFinancialSummary()
    {
        return await _bank.GetFinancialSummaryAsync();
    }

    [McpServerTool]
    [Description("Get recent procurement transactions — PO approval debits and refunds for rejected deliveries. Use this to audit which purchase orders have been paid for and which were refunded. Specify maxCount to control how many to return (default 20, max 500).")]
    public async Task<string> GetProcurementTransactions(
        [Description("Maximum number of transactions to return (1–500). Default 20.")] int maxCount = 20)
    {
        return await _bank.GetProcurementTransactionsAsync(maxCount);
    }

    [McpServerTool]
    [Description("Get recent manufacturing financial transactions. Use the 'type' filter to narrow to: 'completions' (WO overhead), 'payroll' (per-operation labour charges), 'scrap' (write-offs for scrapped units), or 'all' (default). Specify maxCount to control how many to return.")]
    public async Task<string> GetManufacturingFinancials(
        [Description("Filter type: 'all' (default), 'completions', 'payroll', or 'scrap'.")] string? type = null,
        [Description("Maximum number of transactions to return (1–500). Default 20.")] int maxCount = 20)
    {
        return await _bank.GetManufacturingFinancialsAsync(type, maxCount);
    }
}
