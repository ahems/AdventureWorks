param location string
param resourceToken string
param workspaceResourceId string
param webPubSubResourceId string
param metricResources array
param enableGrafana bool = false
param actionGroupId string = ''

var workbookJson = json(replace(loadTextContent('../monitoring/workbook.json'), '__WORKSPACE__', workspaceResourceId))
var metricLinks = [for metric in metricResources: '[${metric.id}: ${metric.metric} (${metric.unit})](https://portal.azure.com/#resource${metric.resourceId}/metrics)']
resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'adventureworks-monitoring')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'AdventureWorks observability'
    category: 'workbook'
    sourceId: workspaceResourceId
    serializedData: string(union(workbookJson, {
      items: concat(workbookJson.items, [{
        type: 1
        name: 'native-resource-metrics'
        content: {
          json: '# Native resource metrics (no duplicate AllMetrics ingestion)\n${join(metricLinks, '\n\n')}\n\nSQL free-limit mode is disabled by default. Functions maximum five 2 GiB workers; DAB up to three replicas at 2 CPU/4 GiB each; MCP maximum one at 1 CPU/2 GiB. Zero minimum replicas are intentional. Web PubSub Free:20 connections/20K messages daily; bytes do not establish remaining daily messages. Tier-specific unavailable metrics must not be zero-filled.'
        }
      }])
    }))
  }
}

// Native portal Grafana resources, not Microsoft.Dashboard/grafana paid workspaces.
resource dashboard 'Microsoft.Dashboard/dashboards@2025-09-01-preview' = if (enableGrafana) {
  name: 'aw-monitoring-${resourceToken}'
  location: location
  properties: {}
}
resource definition 'Microsoft.Dashboard/dashboards/dashboardDefinitions@2025-09-01-preview' = if (enableGrafana) {
  parent: dashboard
  name: 'default'
  properties: {
    serializedData: replace(loadTextContent('../monitoring/grafana.json'), '__WORKSPACE__', workspaceResourceId)
  }
}

var rules = [
  {
    name: 'application-failure-burst'
    description: 'Investigate unexpected application/agent/background failures, not validation or authorization denials.'
    query: '''
      union (AppRequests | where Success == false and toint(ResultCode) >= 500),
        (AppRequests | where tostring(Properties["messaging.operation.type"]) == "process" and tostring(Properties["outcome"]) in ("failed","partial","poisoned")),
        (AppDependencies | where Success == false and tostring(Properties["aw.outcome"]) !in ("rejected","unauthorized","forbidden","cancelled","throttled","retrying")),
        (AppEvents | where Name startswith "BackgroundWork." and tostring(Properties["outcome"]) in ("failed","poisoned"))
      '''
    threshold: 5
    window: 'PT15M'
    severity: 2
  }
  {
    name: 'persistent-model-throttling'
    description: 'Observed model throttling in three distinct five-minute windows; investigate quota/workload, not one recovered retry.'
    query: '''
      AppDependencies
      | where tostring(Properties["aw.outcome"]) == "throttled"
      | summarize windows=dcount(bin(TimeGenerated,5m))
      | where windows >= 3
      '''
    threshold: 1
    window: 'PT15M'
    severity: 2
  }
  {
    name: 'ingestion-pre-cap'
    description: 'Rolling 24-hour billable ingestion exceeds 80% of 1 GB safeguard. This is not the workspace reset window or a billing ceiling; reduce volume/sampling first.'
    query: 'Usage | where IsBillable == true | summarize mb=sum(Quantity) | where mb >= 800'
    threshold: 1
    window: 'P1D'
    severity: 2
  }
  {
    name: 'ingestion-cap-reached'
    description: 'Workspace OverQuota evidence: telemetry incomplete until workspace-specific reset. Overshoot can be billed.'
    query: '_LogOperation | where Category =~ "Ingestion" | where Detail contains "OverQuota"'
    threshold: 1
    window: 'PT15M'
    severity: 1
  }
  {
    name: 'worker-termination'
    description: 'Investigate observed ACA OOM/crash/backoff. Intentional zero replicas are not an outage.'
    query: 'ContainerAppSystemLogs_CL | where Reason_s in ("OOMKilled","ContainerCrashing","ContainerBackOff")'
    threshold: 1
    window: 'PT15M'
    severity: 2
  }
]
resource logAlerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for rule in rules: {
  name: 'aw-${rule.name}-${resourceToken}'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'AdventureWorks ${rule.name}'
    description: rule.description
    enabled: true
    severity: rule.severity
    scopes: [workspaceResourceId]
    // Fresh demos provision alerts before applications create their first telemetry tables.
    skipQueryValidation: true
    evaluationFrequency: 'PT15M'
    windowSize: rule.window
    criteria: {
      allOf: [{
        query: rule.query
        timeAggregation: 'Count'
        operator: 'GreaterThanOrEqual'
        threshold: rule.threshold
        failingPeriods: {
          numberOfEvaluationPeriods: 1
          minFailingPeriodsToAlert: 1
        }
      }]
    }
    actions: {
      actionGroups: empty(actionGroupId) ? [] : [actionGroupId]
    }
    autoMitigate: true
  }
}]
resource connectionPressure 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'aw-webpubsub-pressure-${resourceToken}'
  location: 'global'
  properties: {
    description: 'Web PubSub Free connection quota >=80%; close unused demo tabs. Not remaining daily message quota.'
    severity: 2
    enabled: true
    scopes: [webPubSubResourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        name: 'connectionPressure'
        metricNamespace: 'Microsoft.SignalRService/WebPubSub'
        metricName: 'ConnectionQuotaUtilization'
        operator: 'GreaterThanOrEqual'
        threshold: 80
        timeAggregation: 'Average'
        criterionType: 'StaticThresholdCriterion'
      }]
    }
    actions: empty(actionGroupId) ? [] : [{
      actionGroupId: actionGroupId
    }]
    autoMitigate: true
  }
}
