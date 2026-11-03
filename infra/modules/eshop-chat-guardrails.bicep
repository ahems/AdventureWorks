@description('Existing Microsoft Foundry account containing the chat deployment.')
param accountName string

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: accountName
}

var promptSafetyControls = [for risk in ['Hate', 'Sexual', 'Violence', 'Selfharm']: {
  name: risk
  source: 'Prompt'
  enabled: true
  blocking: true
  severityThreshold: 'Medium'
}]

var outputSafetyControls = [for risk in ['Hate', 'Sexual', 'Violence', 'Selfharm']: {
  name: risk
  source: 'Completion'
  enabled: true
  blocking: true
  severityThreshold: 'Medium'
}]

resource outputBlocklist 'Microsoft.CognitiveServices/accounts/raiBlocklists@2025-06-01' = {
  parent: account
  name: 'AdventureWorks-Chat-CodeOutput'
  properties: {
    description: 'Supplemental code-output patterns for the shopping-only chat. Not a complete code classifier.'
  }
}

resource codePatterns 'Microsoft.CognitiveServices/accounts/raiBlocklists/raiBlocklistItems@2025-06-01' = {
  parent: outputBlocklist
  name: 'code-syntax'
  properties: {
    isRegex: true
    pattern: '```|\\bdef\\s+\\w+\\s*\\(|\\bprint\\s*\\(|\\bfor\\s+\\w+\\s+in\\s+range\\s*\\(|\\bconsole\\.log\\s*\\('
  }
}

resource policy 'Microsoft.CognitiveServices/accounts/raiPolicies@2025-06-01' = {
  parent: account
  name: 'AdventureWorks-Eshop'
  properties: {
    basePolicyName: 'Microsoft.DefaultV2'
    mode: 'Blocking'
    contentFilters: concat(promptSafetyControls, outputSafetyControls, [
      {
        name: 'Jailbreak'
        source: 'Prompt'
        enabled: true
        blocking: true
      }
      {
        name: 'Protected Material Text'
        source: 'Completion'
        enabled: true
        blocking: true
      }
      {
        name: 'Protected Material Code'
        source: 'Completion'
        enabled: true
        blocking: false
      }
    ])
    customBlocklists: [
      {
        blocklistName: outputBlocklist.name
        source: 'Completion'
        blocking: true
      }
    ]
  }
  dependsOn: [codePatterns]
}

output policyName string = policy.name
output policyId string = policy.id
