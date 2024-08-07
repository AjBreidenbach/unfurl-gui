/*
process.env.OC_URL = 'http://skelaware.abreidenbach.com:3000'
process.env.OC_USERNAME = 'root'
process.env.OC_PASSWORD = '******'
*/

const FormData = require('form-data')
const axios = require('./axios-instance.js')
const {extractCsrf} = require("./util.js")
const fs = require('fs')

const authenticityTokenRegex = /name="csrf-token"\s+content="(([A-Za-z0-9+/=])+)"/i
let loggedIn = false
async function login(gitlabURL, gitlabUsername, gitlabPassword, impersonate, force=false) {
  if(loggedIn && !force) return
  let result

  {
    const form = new FormData()

    const signInURL = `${gitlabURL || process.env.UNFURL_CLOUD_SERVER || process.env.OC_URL}/users/sign_in`
    const res = await axios.get(signInURL)
    const authenticity_token = extractCsrf(res.data)
    form.append('authenticity_token', authenticity_token)
    form.append('user[login]', gitlabUsername || process.env.OC_USERNAME)
    form.append('user[password]', gitlabPassword || process.env.OC_PASSWORD)
    form.append('user[remember_me]', 0)

    const headers = {
      ...form.getHeaders(),
      "Content-Length": form.getLengthSync()
    }

    const response = await axios.post(signInURL, form, {headers})

    fs.writeFileSync('/tmp/login.html', response.data, 'utf8')

    const status = response.status

    const statusOk = status < 400 && status >= 200
    const credentialsOk = !response.data.includes('Invalid login or password.')
    loggedIn = result = (statusOk && credentialsOk)
  }

  let impersonateUser
  if(result && (impersonateUser = impersonate || process.env.OC_IMPERSONATE)) {
    const adminUserPage = `${process.env.UNFURL_CLOUD_SERVER || process.env.OC_URL}/admin/users/${impersonateUser}`
    const authenticity_token = extractCsrf((await axios.get(adminUserPage)).data)

    const form = new FormData()
    form.append('_method', 'post')
    form.append('authenticity_token', authenticity_token)

    const headers = {
      ...form.getHeaders(),
      "Content-Length": form.getLengthSync()
    }

    const adminImpersonateURL = `${process.env.UNFURL_CLOUD_SERVER || process.env.OC_URL}/admin/users/${impersonateUser}/impersonate`
    result = (await axios.post(adminImpersonateURL, form, {headers})).status

  }

  return result
}

module.exports = login
