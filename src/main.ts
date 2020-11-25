/******************************************************************************\
 * Main entrypoint for GitHib Action. Fetches information regarding the       *
 * currently running Workflow and it's Jobs. Sends individual job status and  *
 * workflow status as a formatted notification to the Slack Webhhok URL set   *
 * in the environment variables.                                              *
 *                                                                            *
 * Org: Gamesight <https://gamesight.io>                                      *
 * Author: Anthony Kinson <anthony@gamesight.io>                              *
 * Repository: https://github.com/Gamesight/slack-workflow-status             *
 * License: MIT                                                               *
 * Copyright (c) 2020 Gamesight, Inc                                               *
\******************************************************************************/

import * as core from '@actions/core'
import {context, getOctokit} from  '@actions/github'
import * as request from 'request-promise-native'


interface SlackPayloadBody {
    channel?: string,
    username?: string,
    icon_emoji?: string,
    icon_url?: string,
    attachments: SlackAttachment[]
}

interface SlackAttachment {
  mrkdwn_in: [string]
  color: string
  text: string
  footer: string
  footer_icon: string
  fields: SlackAttachmentFields[]
  author_icon?: string
  author_link?: string
  author_name?: string
  fallback?: string
  image_url?: string
  pretext?: string
  thumb_url?: string
  title?: string
  title_link?: string
  ts?: number
}

interface SlackAttachmentFields {
  short: boolean
  value: string
  title?: string
}

// HACK: https://github.com/octokit/types.ts/issues/205
interface PullRequest {
  url: string
  id: number
  number: number
  head: {
    ref: string
    sha: string
    repo: {
      id: number
      url: string
      name: string
    }
    }
  base: {
    ref: string
    sha: string
    repo: {
      id: number
      url: string
      name: string
    }
  }
}

process.on('unhandledRejection', handleError)
main().catch(handleError)

// Action entrypoint
async function main(){
  // Collect Action Inputs
  const webhook_url: string = core.getInput('slack_webhook_url', { required: true })
  const github_token: string = core.getInput('repo_token', { required: true })
  const include_jobs: string = core.getInput('include_jobs', { required: true })
  const slack_channel: string = core.getInput('channel')
  const slack_name: string = core.getInput('name')
  const slack_icon: string = core.getInput('icon_url')
  const slack_emoji: string = core.getInput('icon_emoji') // https://www.webfx.com/tools/emoji-cheat-sheet/
  // Force as secret, forces *** when trying to print or log values
  core.setSecret(github_token)
  core.setSecret(webhook_url)
  // Auth github with octokit module
  const octokit = getOctokit(github_token)
  // Fetch workflow run data
  const { data: workflow_run } = await octokit.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId
  })

  // Fetch workflow job information
  const {data: jobs_response} = await octokit.listJobsForWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: context.runId
  })

  // Build Job Data Fields and Workflow Status
  let job_fields: SlackAttachmentFields[] = []
  let workflow_success = true
  let workflow_failure = false
  let job_status_icon = "✓"

  for(let job of jobs_response.jobs){
    // Ignore the job that is running this action.
    if(job.status != "completed"){
      continue
    }
    // Setup some slack content for job status
    if(job.conclusion == "success"){
      job_status_icon = "✓"
    }
    // If a job fails do concluide "success" then the workflow isn't successful
    // we assume it was cancelled unless...
    if(job.conclusion == "cancelled"){
      workflow_success = false
      job_status_icon = "⃠"
    }
    // ...the job conclusion is failure, we mark as failed and set the icon
    if(job.conclusion == "failure") {
      workflow_failure = true
      job_status_icon = "✗"
    }
    // Create a new field for this job
    job_fields.push({
      short: true,
      value: `${job_status_icon} <${job.html_url}|${job.name}> (${job_duration(new Date(job.started_at), new Date(job.completed_at))})`
    })
  }

  // Configure slack attachment styling
  let workflow_color: string = "" // can be good, danger, warning or a HEX colour (#00FF00)
  let workflow_msg: string = ""

  if(workflow_success){
    workflow_color = "good"
    workflow_msg = "Success:"
  }else if(workflow_failure){
    workflow_color = "danger"
    workflow_msg = "Failed:"
  }else{
    workflow_color = "warning"
    workflow_msg = "Cancelled:"
  }

  // Payload Formatting Shortcuts
  const workflow_duration: string = job_duration(new Date(workflow_run.created_at), new Date(workflow_run.updated_at))
  const repo_url: string = `<${workflow_run.repository.html_url}|*${workflow_run.repository.full_name}*>`
  const branch_url: string = `<${workflow_run.repository.html_url}/tree/${workflow_run.head_branch}|*${workflow_run.head_branch}*>`
  // Example: Success: AnthonyKinson's `push` on `master` for pull_request
  let status_string: string = `${workflow_msg} ${context.actor}'s \`${context.eventName}\` on \`${branch_url}\`\n`
  // Example: Workflow: My Workflow #14 completed in `1m 30s`
  const workflow_run_url: string = `<${workflow_run.html_url}|#${workflow_run.run_number}>`
  const details_string: string = `Workflow: ${context.workflow} ${workflow_run_url} completed in \`${workflow_duration}\``

  // Build Pull Request string if required
  let pull_requests = ""
  for(let pull_request of workflow_run.pull_requests as PullRequest[]){
    pull_requests += `, <${workflow_run.repository.html_url}/pull/${pull_request.number}|#${pull_request.number}> from \`${pull_request.head.ref}\` to \`${pull_request.base.ref}\``
  }
  if(pull_requests != ""){
    pull_requests = pull_requests.substr(1)
    status_string = `${workflow_msg} ${context.actor}'s \`pull_request\`${pull_requests}\n`
  }

  // We're using old style attachments rather than the new blocks because:
  // - Blocks don't allow colour indicators on messages
  // - Block are limited to 10 fields. >10 jobs in a workflow results in payload failure

  // Build our notification attachment
  const slack_attachment: SlackAttachment = {
    mrkdwn_in: ["text"],
    color: workflow_color,
    text: status_string + details_string,
    footer: repo_url,
    footer_icon: "https://github.githubassets.com/favicon.ico",
    fields: (include_jobs == 'true') ? job_fields : []
  }
  // Build our notification payload
  const slack_payload_body: SlackPayloadBody = {
    attachments: [slack_attachment]
  }

  // Do we have any overrides?
  if(slack_name != ""){
    slack_payload_body.username = slack_name
  }
  if(slack_channel != ""){
    slack_payload_body.channel = slack_channel
  }
  if(slack_emoji != ""){
    slack_payload_body.icon_emoji = slack_emoji
  }
  if(slack_icon != ""){
    slack_payload_body.icon_url = slack_icon
  }

  const request_options = {
    uri: webhook_url,
    method: 'POST',
    body: slack_payload_body,
    json: true
  }

  request(request_options).catch(err => {
    core.setFailed(err)
  })
}

// Converts start and end dates into a duration string
const job_duration = function(start: any, end: any){
  const duration = end - start
  let delta = duration / 1000
  let days = Math.floor(delta / 86400)
  delta -= days * 86400
  let hours = Math.floor(delta / 3600) % 24
  delta -= hours * 3600
  let minutes = Math.floor(delta / 60) % 60
  delta -= minutes * 60
  let seconds = Math.floor(delta % 60)
  // Format duration sections
  const format_duration = function(value: number, text: string, hide_on_zero: boolean): string {
    return (value <= 0 && hide_on_zero) ? "" : value + text + " "
  }
  return format_duration(days, "d", true) + format_duration(hours, "h", true) + format_duration(minutes, "m", true) + format_duration(seconds, "s", false).trim()
}

function handleError(err: any){
  console.error(err)
  if(err && err.message){
    core.setFailed(err.message)
  }else{
    core.setFailed(`Unhandled Error: ${err}`)
  }
}
